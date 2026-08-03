import { randomBytes } from 'node:crypto';

import { WebSocketServer } from 'ws';

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  MAX_CLIENT_MESSAGE_BURST,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_CLIENT_MESSAGES_PER_SECOND,
  MAX_CLIENT_BYTES_PER_SECOND,
  MAX_CLIENT_BYTE_BURST,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  parseClientMessage,
  serverMessage,
} from '../src/net/protocol.js';
import { asErrorMessage, GameError } from './game-error.js';

const AUTH_ACTIONS = new Set([
  CLIENT_MESSAGE_TYPES.CREATE_ROOM,
  CLIENT_MESSAGE_TYPES.JOIN_ROOM,
  CLIENT_MESSAGE_TYPES.QUICK_MATCH,
  CLIENT_MESSAGE_TYPES.RESUME,
]);

// Room presence needs to react well inside the 30-second resume window. With
// the two-pass alive check below, this detects a silent connection loss in
// roughly 3-6 seconds instead of allowing false/true room states to bunch up
// around the eventual resume attempt.
export const ROOM_PRESENCE_HEARTBEAT_INTERVAL_MS = 3_000;
export const SNAPSHOT_BACKPRESSURE_FLOOR_BYTES = 16 * 1024;
export const SLOW_CLIENT_BACKPRESSURE_BYTES = 512 * 1024;

export function snapshotBackpressureThreshold(serializedBytes) {
  return Math.max(
    SNAPSHOT_BACKPRESSURE_FLOOR_BYTES,
    Math.max(0, Number(serializedBytes) || 0) * 2,
  );
}

export function outgoingMessageAction({
  bufferedAmount = 0,
  messageType,
  serializedBytes = 0,
  snapshotFloorBytes = SNAPSHOT_BACKPRESSURE_FLOOR_BYTES,
  slowClientBytes = SLOW_CLIENT_BACKPRESSURE_BYTES,
} = {}) {
  if (bufferedAmount > slowClientBytes) return 'close';
  if (messageType === SERVER_MESSAGE_TYPES.SNAPSHOT
    && bufferedAmount > Math.max(snapshotFloorBytes, Math.max(0, serializedBytes) * 2)) {
    return 'skip';
  }
  return 'send';
}

function connectionId() {
  return randomBytes(9).toString('base64url');
}

export function clientAddress(request, trustProxy = false) {
  const forwarded = trustProxy ? request.headers['x-forwarded-for'] : null;
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress ?? 'unknown';
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (allowedOrigins instanceof Set) return allowedOrigins;
  if (Array.isArray(allowedOrigins)) return new Set(allowedOrigins.filter(Boolean));
  if (typeof allowedOrigins === 'string') {
    return new Set(allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean));
  }
  return new Set();
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function isOriginAllowed(request, allowedOrigins = new Set()) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  if (allowedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === request.headers.host && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return;
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n`
    + `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

function addSelfState(message, participantId) {
  if (message.type !== SERVER_MESSAGE_TYPES.ROOM_STATE || !participantId) return message;
  const member = message.members?.find((candidate) => candidate.participantId === participantId) ?? null;
  return {
    ...message,
    selfParticipantId: participantId,
    self: member ? {
      participantId,
      isHost: member.isHost,
      ready: member.ready,
      connected: member.connected,
      characterId: member.characterId,
      paintId: member.paintId,
      avatarId: member.avatarId,
    } : null,
  };
}

export function attachGameWebSocket(httpServer, {
  roomManager,
  path = '/ws',
  allowedOrigins = [],
  logger = console,
  heartbeatIntervalMs = ROOM_PRESENCE_HEARTBEAT_INTERVAL_MS,
  authAttemptLimit = 20,
  authAttemptWindowMs = 60_000,
  messageRatePerSecond = MAX_CLIENT_MESSAGES_PER_SECOND,
  messageBurst = MAX_CLIENT_MESSAGE_BURST,
  byteRatePerSecond = MAX_CLIENT_BYTES_PER_SECOND,
  byteBurst = MAX_CLIENT_BYTE_BURST,
  trustProxy = process.env.TRUST_PROXY === 'true',
  snapshotBackpressureFloorBytes = SNAPSHOT_BACKPRESSURE_FLOOR_BYTES,
  slowClientBytes = SLOW_CLIENT_BACKPRESSURE_BYTES,
  stringify = JSON.stringify,
  metrics = null,
  lobbyBroadcastDebounceMs = nonNegativeNumber(process.env.LOBBY_BROADCAST_DEBOUNCE_MS, 100),
  serverStatsDebounceMs = 250,
} = {}) {
  if (!httpServer || !roomManager) throw new TypeError('httpServer and roomManager are required.');

  const originAllowlist = normalizeAllowedOrigins(allowedOrigins);
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const sessions = new Set();
  const lobbySessions = new Set();
  const roomSessions = new Map();
  const participantSessions = new Map();
  const authAttempts = new Map();
  let lobbyBroadcastTimer = null;
  let pendingLobbyRooms = null;
  let serverStatsTimer = null;
  let closed = false;

  function sendSerialized(session, serialized, messageType, serializedBytes) {
    if (!session || session.socket.readyState !== 1) return false;
    const action = outgoingMessageAction({
      bufferedAmount: session.socket.bufferedAmount,
      messageType,
      serializedBytes,
      snapshotFloorBytes: snapshotBackpressureFloorBytes,
      slowClientBytes,
    });
    if (action === 'close') {
      metrics?.increment('snapshot', 'slowConnectionsClosed');
      session.socket.close(1013, 'Client is too slow');
      return false;
    }
    if (action === 'skip') {
      metrics?.increment('snapshot', 'backpressureSkipped');
      return false;
    }
    session.socket.send(serialized);
    metrics?.recordTraffic('outbound', messageType, serializedBytes);
    if (messageType === SERVER_MESSAGE_TYPES.SNAPSHOT) {
      metrics?.recordSnapshot({ bytes: serializedBytes, built: false, sent: 1 });
    }
    return true;
  }

  function send(session, message) {
    if (!session || session.socket.readyState !== 1) return false;
    const personalized = addSelfState(message, session.participantId);
    const serialized = stringify(personalized);
    return sendSerialized(
      session,
      serialized,
      personalized.type,
      Buffer.byteLength(serialized),
    );
  }

  function sendError(session, error) {
    const payload = asErrorMessage(error);
    send(session, serverMessage(SERVER_MESSAGE_TYPES.ERROR, payload));
  }

  function lobbyState() {
    return serverMessage(SERVER_MESSAGE_TYPES.LOBBY_STATE, {
      rooms: roomManager.listRooms(),
    });
  }

  function serverStats() {
    return serverMessage(SERVER_MESSAGE_TYPES.SERVER_STATS, {
      onlineCount: sessions.size,
      serverTime: Date.now(),
    });
  }

  function broadcastShared(message, recipients) {
    const serialized = stringify(message);
    const serializedBytes = Buffer.byteLength(serialized);
    let sent = 0;
    for (const session of recipients) {
      if (sendSerialized(session, serialized, message.type, serializedBytes)) sent++;
    }
    return { sent, serializedBytes };
  }

  function flushServerStats() {
    serverStatsTimer = null;
    broadcastShared(serverStats(), sessions);
  }

  function scheduleServerStats() {
    if (serverStatsTimer || closed) return;
    serverStatsTimer = setTimeout(flushServerStats, serverStatsDebounceMs);
    serverStatsTimer.unref?.();
  }

  function removeFromRoomIndex(session) {
    const roomCode = session.indexedRoomCode;
    if (!roomCode) return;
    const roomSet = roomSessions.get(roomCode);
    roomSet?.delete(session);
    if (roomSet?.size === 0) roomSessions.delete(roomCode);
    session.indexedRoomCode = null;
  }

  function addToRoomIndex(session, roomCode) {
    removeFromRoomIndex(session);
    lobbySessions.delete(session);
    let roomSet = roomSessions.get(roomCode);
    if (!roomSet) {
      roomSet = new Set();
      roomSessions.set(roomCode, roomSet);
    }
    roomSet.add(session);
    session.indexedRoomCode = roomCode;
  }

  function sendLobbyState(session, rooms = roomManager.listRooms()) {
    const message = serverMessage(SERVER_MESSAGE_TYPES.LOBBY_STATE, { rooms });
    const serialized = stringify(message);
    const serializedBytes = Buffer.byteLength(serialized);
    metrics?.increment('lobby', 'builds');
    const sent = sendSerialized(session, serialized, message.type, serializedBytes);
    if (sent) {
      metrics?.increment('lobby', 'recipients');
      metrics?.increment('lobby', 'bytes', serializedBytes);
    }
  }

  function flushLobbyState() {
    lobbyBroadcastTimer = null;
    const rooms = pendingLobbyRooms ?? roomManager.listRooms();
    pendingLobbyRooms = null;
    const message = serverMessage(SERVER_MESSAGE_TYPES.LOBBY_STATE, { rooms });
    metrics?.increment('lobby', 'builds');
    const { sent, serializedBytes } = broadcastShared(message, lobbySessions);
    metrics?.increment('lobby', 'broadcasts');
    metrics?.increment('lobby', 'recipients', sent);
    metrics?.increment('lobby', 'bytes', sent * serializedBytes);
  }

  function scheduleLobbyState(rooms = null) {
    pendingLobbyRooms = rooms;
    if (lobbyBroadcastTimer || closed) return;
    lobbyBroadcastTimer = setTimeout(flushLobbyState, lobbyBroadcastDebounceMs);
    lobbyBroadcastTimer.unref?.();
  }

  function subscribeLobby(session, { sendState = true } = {}) {
    removeFromRoomIndex(session);
    session.inLobby = true;
    lobbySessions.add(session);
    if (sendState) sendLobbyState(session);
  }

  function bindParticipant(session, result) {
    const previous = participantSessions.get(result.participantId);
    if (previous && previous !== session) previous.socket.close(4001, 'Session resumed elsewhere');
    lobbySessions.delete(session);
    session.participantId = result.participantId;
    session.roomCode = result.roomCode;
    session.inLobby = false;
    addToRoomIndex(session, result.roomCode);
    participantSessions.set(result.participantId, session);
    const sessionState = {
      roomCode: result.roomCode,
      participantId: result.participantId,
      resumeToken: result.resumeToken,
      resumed: Boolean(result.resumed),
    };
    send(session, serverMessage(SERVER_MESSAGE_TYPES.WELCOME, {
      connectionId: session.connectionId,
      serverTime: Date.now(),
      ...sessionState,
      session: sessionState,
    }));
    if (Array.isArray(result.messages)) {
      for (const message of result.messages) send(session, message);
    } else if (result.roomState) {
      send(session, result.roomState);
    }
  }

  function unbindParticipant(session, disconnect) {
    lobbySessions.delete(session);
    removeFromRoomIndex(session);
    const participantId = session.participantId;
    if (!participantId) return;
    if (participantSessions.get(participantId) === session) {
      participantSessions.delete(participantId);
      if (disconnect) roomManager.disconnect(participantId);
    }
    session.participantId = null;
    session.roomCode = null;
    session.inLobby = false;
  }

  function consumeMessageBudget(session) {
    const now = Date.now();
    const elapsed = Math.max(0, now - session.messageBudgetUpdatedAt);
    session.messageBudgetUpdatedAt = now;
    session.messageTokens = Math.min(
      messageBurst,
      session.messageTokens + elapsed * messageRatePerSecond / 1000,
    );
    if (session.messageTokens < 1) return false;
    session.messageTokens -= 1;
    return true;
  }

  function consumeByteBudget(session, bytes) {
    const now = Date.now();
    const elapsed = Math.max(0, now - session.byteBudgetUpdatedAt);
    session.byteBudgetUpdatedAt = now;
    session.byteTokens = Math.min(
      byteBurst,
      session.byteTokens + elapsed * byteRatePerSecond / 1000,
    );
    if (session.byteTokens < bytes) return false;
    session.byteTokens -= bytes;
    return true;
  }

  function consumeAuthBudget(ip) {
    const now = Date.now();
    const cutoff = now - authAttemptWindowMs;
    const attempts = (authAttempts.get(ip) ?? []).filter((at) => at > cutoff);
    if (attempts.length >= authAttemptLimit) {
      authAttempts.set(ip, attempts);
      return false;
    }
    attempts.push(now);
    authAttempts.set(ip, attempts);
    return true;
  }

  async function dispatch(session, message) {
    if (AUTH_ACTIONS.has(message.type)) {
      if (session.participantId) {
        throw new GameError(ERROR_CODES.ALREADY_IN_ROOM, 'Leave the current room first.');
      }
      metrics?.increment('auth', 'attempts');
      if (!consumeAuthBudget(session.ip)) {
        metrics?.increment('auth', 'rateLimited');
        throw new GameError(ERROR_CODES.RATE_LIMITED, 'Too many room attempts. Try again shortly.');
      }
    } else if (!session.participantId
      && message.type !== CLIENT_MESSAGE_TYPES.ENTER_LOBBY
      && message.type !== CLIENT_MESSAGE_TYPES.PING) {
      throw new GameError(ERROR_CODES.NOT_IN_ROOM, 'Create, join, or resume a room first.');
    }

    switch (message.type) {
      case CLIENT_MESSAGE_TYPES.ENTER_LOBBY:
        if (session.participantId) {
          throw new GameError(ERROR_CODES.ALREADY_IN_ROOM, 'Leave the current room first.');
        }
        subscribeLobby(session);
        break;
      case CLIENT_MESSAGE_TYPES.CREATE_ROOM:
        lobbySessions.delete(session);
        session.inLobby = false;
        try {
          bindParticipant(session, await roomManager.createRoom(message));
        } catch (error) {
          subscribeLobby(session, { sendState: false });
          throw error;
        }
        logger.info?.(`[multiplayer] room created by ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.JOIN_ROOM:
        lobbySessions.delete(session);
        session.inLobby = false;
        try {
          bindParticipant(session, await roomManager.joinRoom(message.roomCode, message));
        } catch (error) {
          subscribeLobby(session, { sendState: false });
          throw error;
        }
        logger.info?.(`[multiplayer] room joined from ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.QUICK_MATCH:
        lobbySessions.delete(session);
        session.inLobby = false;
        try {
          bindParticipant(session, await roomManager.quickMatch(message));
        } catch (error) {
          subscribeLobby(session, { sendState: false });
          throw error;
        }
        logger.info?.(`[multiplayer] quick match joined from ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.RESUME:
        lobbySessions.delete(session);
        session.inLobby = false;
        try {
          bindParticipant(session, roomManager.resume(
            message.roomCode, message.participantId, message.resumeToken,
          ));
        } catch (error) {
          session.inLobby = false;
          throw error;
        }
        logger.info?.(`[multiplayer] session resumed from ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.SELECT_CHARACTER:
        roomManager.selectCharacter(session.participantId, message.characterId);
        break;
      case CLIENT_MESSAGE_TYPES.SET_LOADOUT:
        roomManager.setLoadout(session.participantId, message);
        break;
      case CLIENT_MESSAGE_TYPES.SET_ROOM:
        roomManager.setRoom(session.participantId, message);
        break;
      case CLIENT_MESSAGE_TYPES.SET_READY:
        roomManager.setReady(session.participantId, message.ready);
        break;
      case CLIENT_MESSAGE_TYPES.KICK_PLAYER:
        roomManager.kickPlayer(session.participantId, message.participantId);
        break;
      case CLIENT_MESSAGE_TYPES.START_RACE:
        roomManager.startRace(session.participantId);
        logger.info?.('[multiplayer] race loading started');
        break;
      case CLIENT_MESSAGE_TYPES.RACE_LOADED:
        await roomManager.markRaceLoaded(session.participantId, message.raceId);
        break;
      case CLIENT_MESSAGE_TYPES.INPUT:
        roomManager.handleInput(session.participantId, message);
        break;
      case CLIENT_MESSAGE_TYPES.RETURN_ROOM:
        roomManager.returnToRoom(session.participantId);
        break;
      case CLIENT_MESSAGE_TYPES.LEAVE_ROOM: {
        const participantId = session.participantId;
        unbindParticipant(session, false);
        roomManager.leave(participantId);
        subscribeLobby(session);
        break;
      }
      case CLIENT_MESSAGE_TYPES.PING: {
        const room = session.roomCode ? roomManager.rooms.get(session.roomCode) : null;
        send(session, serverMessage(SERVER_MESSAGE_TYPES.PONG, {
          clientTime: message.clientTime,
          serverTime: Date.now(),
          onlineCount: sessions.size,
          tick: room?.race?.tick ?? null,
        }));
        break;
      }
      default:
        throw new GameError(ERROR_CODES.UNKNOWN_MESSAGE, 'Unknown message type.');
    }
  }

  function onManagerMessage({ roomCode, participantId, message }) {
    if (participantId) {
      send(participantSessions.get(participantId), message);
      return;
    }
    if (message.type === SERVER_MESSAGE_TYPES.SNAPSHOT) {
      const serialized = stringify(message);
      const serializedBytes = Buffer.byteLength(serialized);
      metrics?.recordSnapshot({ bytes: serializedBytes, built: true, sent: 0 });
      const recipients = roomSessions.get(roomCode);
      if (!recipients) return;
      for (const session of recipients) {
        sendSerialized(session, serialized, message.type, serializedBytes);
      }
      return;
    }
    for (const session of roomSessions.get(roomCode) ?? []) send(session, message);
  }

  function onLobbyChanged({ rooms } = {}) {
    scheduleLobbyState(rooms ?? null);
  }

  function onRoomDestroyed({ roomCode }) {
    for (const session of [...(roomSessions.get(roomCode) ?? [])]) {
      sendError(session, new GameError(ERROR_CODES.ROOM_NOT_FOUND, 'The room expired.'));
      unbindParticipant(session, false);
      subscribeLobby(session);
    }
  }

  function onParticipantKicked({ roomCode, roomName, participantId }) {
    const session = participantSessions.get(participantId);
    if (!session) return;
    send(session, serverMessage(SERVER_MESSAGE_TYPES.KICKED, {
      roomCode,
      roomName,
      message: 'You were removed from the room by the host.',
    }));
    unbindParticipant(session, false);
    subscribeLobby(session);
  }

  function onUpgrade(request, socket, head) {
    let requestPath;
    try {
      requestPath = new URL(request.url, 'http://localhost').pathname;
    } catch {
      rejectUpgrade(socket, '400 Bad Request', 'Bad Request');
      return;
    }
    if (requestPath !== path) {
      rejectUpgrade(socket, '404 Not Found', 'Not Found');
      return;
    }
    if (!isOriginAllowed(request, originAllowlist)) {
      rejectUpgrade(socket, '403 Forbidden', 'Forbidden');
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  }

  function onConnection(socket, request) {
    const session = {
      socket,
      connectionId: connectionId(),
      ip: clientAddress(request, trustProxy),
      participantId: null,
      roomCode: null,
      inLobby: false,
      indexedRoomCode: null,
      alive: true,
      messageBudgetUpdatedAt: Date.now(),
      messageTokens: messageBurst,
      byteBudgetUpdatedAt: Date.now(),
      byteTokens: byteBurst,
    };
    sessions.add(session);
    socket.on('pong', () => { session.alive = true; });
    socket.on('error', (error) => logger.warn?.(`[multiplayer] websocket error: ${error.message}`));
    socket.on('close', () => {
      sessions.delete(session);
      unbindParticipant(session, true);
      scheduleServerStats();
    });
    socket.on('message', (data, isBinary) => {
      const messageBytes = data.byteLength;
      if (isBinary || messageBytes > MAX_CLIENT_MESSAGE_BYTES) {
        socket.close(1009, 'Message too large');
        return;
      }
      if (!consumeMessageBudget(session) || !consumeByteBudget(session, messageBytes)) {
        sendError(session, new GameError(ERROR_CODES.RATE_LIMITED, 'Message rate limit exceeded.'));
        socket.close(1008, 'Rate limit exceeded');
        return;
      }
      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) {
        metrics?.recordTraffic('inbound', 'invalid', messageBytes);
        sendError(session, new GameError(parsed.error.code, parsed.error.message));
        return;
      }
      metrics?.recordTraffic('inbound', parsed.value.type, messageBytes);
      Promise.resolve(dispatch(session, parsed.value)).catch((error) => {
        if (!(error instanceof GameError)) logger.error?.('[multiplayer] request failed', error);
        sendError(session, error);
      });
    });
    send(session, serverMessage(SERVER_MESSAGE_TYPES.WELCOME, {
      connectionId: session.connectionId,
      serverTime: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      session: null,
    }));
    scheduleServerStats();
  }

  httpServer.on('upgrade', onUpgrade);
  wss.on('connection', onConnection);
  roomManager.on('message', onManagerMessage);
  roomManager.on('lobbyChanged', onLobbyChanged);
  roomManager.on('roomDestroyed', onRoomDestroyed);
  roomManager.on('participantKicked', onParticipantKicked);
  roomManager.setRoomReceiverCountProvider?.((roomCode) => roomSessions.get(roomCode)?.size ?? 0);

  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  function maintenance(now = Date.now()) {
    for (const [ip, attempts] of authAttempts) {
      const current = attempts.filter((at) => at > now - authAttemptWindowMs);
      if (current.length) authAttempts.set(ip, current);
      else authAttempts.delete(ip);
    }
  }

  async function close({ code = 1012, reason = 'Server restarting' } = {}) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (lobbyBroadcastTimer) clearTimeout(lobbyBroadcastTimer);
    if (serverStatsTimer) clearTimeout(serverStatsTimer);
    httpServer.off('upgrade', onUpgrade);
    roomManager.off('message', onManagerMessage);
    roomManager.off('lobbyChanged', onLobbyChanged);
    roomManager.off('roomDestroyed', onRoomDestroyed);
    roomManager.off('participantKicked', onParticipantKicked);
    for (const session of sessions) session.socket.close(code, reason);
    roomManager.setRoomReceiverCountProvider?.(null);
    await new Promise((resolve) => wss.close(resolve));
  }

  return {
    wss,
    sessions,
    lobbySessions,
    roomSessions,
    get connectionCount() { return sessions.size; },
    maintenance,
    close,
  };
}
