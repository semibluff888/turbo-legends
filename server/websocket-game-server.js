import { randomBytes } from 'node:crypto';

import { WebSocketServer } from 'ws';

import {
  CLIENT_MESSAGE_TYPES,
  ERROR_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_CLIENT_MESSAGES_PER_SECOND,
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

function connectionId() {
  return randomBytes(9).toString('base64url');
}

function clientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
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
    } : null,
  };
}

export function attachGameWebSocket(httpServer, {
  roomManager,
  path = '/ws',
  allowedOrigins = [],
  logger = console,
  heartbeatIntervalMs = 15_000,
  authAttemptLimit = 20,
  authAttemptWindowMs = 60_000,
  snapshotBackpressureBytes = 256 * 1024,
  slowClientBytes = 1024 * 1024,
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
  const participantSessions = new Map();
  const authAttempts = new Map();
  let closed = false;

  function send(session, message) {
    if (!session || session.socket.readyState !== 1) return false;
    if (session.socket.bufferedAmount > slowClientBytes) {
      session.socket.close(1013, 'Client is too slow');
      return false;
    }
    if (message.type === SERVER_MESSAGE_TYPES.SNAPSHOT
      && session.socket.bufferedAmount > snapshotBackpressureBytes) return false;
    const personalized = addSelfState(message, session.participantId);
    session.socket.send(JSON.stringify(personalized));
    return true;
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

  function subscribeLobby(session, { sendState = true } = {}) {
    session.inLobby = true;
    if (sendState) send(session, lobbyState());
  }

  function bindParticipant(session, result) {
    const previous = participantSessions.get(result.participantId);
    if (previous && previous !== session) previous.socket.close(4001, 'Session resumed elsewhere');
    session.participantId = result.participantId;
    session.roomCode = result.roomCode;
    session.inLobby = false;
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
    if (now - session.messageWindowStartedAt >= 1000) {
      session.messageWindowStartedAt = now;
      session.messageCount = 0;
    }
    session.messageCount++;
    return session.messageCount <= MAX_CLIENT_MESSAGES_PER_SECOND;
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
      if (!consumeAuthBudget(session.ip)) {
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
        session.inLobby = false;
        try {
          bindParticipant(session, roomManager.createRoom(message));
        } catch (error) {
          session.inLobby = true;
          throw error;
        }
        logger.info?.(`[multiplayer] room created by ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.JOIN_ROOM:
        session.inLobby = false;
        try {
          bindParticipant(session, roomManager.joinRoom(message.roomCode, message));
        } catch (error) {
          session.inLobby = true;
          throw error;
        }
        logger.info?.(`[multiplayer] room joined from ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.QUICK_MATCH:
        session.inLobby = false;
        try {
          bindParticipant(session, roomManager.quickMatch(message));
        } catch (error) {
          session.inLobby = true;
          throw error;
        }
        logger.info?.(`[multiplayer] quick match joined from ${session.ip}`);
        break;
      case CLIENT_MESSAGE_TYPES.RESUME:
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
      case CLIENT_MESSAGE_TYPES.SET_ROOM:
        roomManager.setRoom(session.participantId, message);
        break;
      case CLIENT_MESSAGE_TYPES.SET_READY:
        roomManager.setReady(session.participantId, message.ready);
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
    for (const session of sessions) {
      if (session.roomCode === roomCode) send(session, message);
    }
  }

  function onLobbyChanged() {
    const message = lobbyState();
    for (const session of sessions) {
      if (session.inLobby && !session.participantId) send(session, message);
    }
  }

  function onRoomDestroyed({ roomCode }) {
    for (const session of sessions) {
      if (session.roomCode !== roomCode) continue;
      sendError(session, new GameError(ERROR_CODES.ROOM_NOT_FOUND, 'The room expired.'));
      unbindParticipant(session, false);
      subscribeLobby(session);
    }
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
      ip: clientAddress(request),
      participantId: null,
      roomCode: null,
      inLobby: false,
      alive: true,
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    };
    sessions.add(session);
    socket.on('pong', () => { session.alive = true; });
    socket.on('error', (error) => logger.warn?.(`[multiplayer] websocket error: ${error.message}`));
    socket.on('close', () => {
      sessions.delete(session);
      unbindParticipant(session, true);
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary || data.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        socket.close(1009, 'Message too large');
        return;
      }
      if (!consumeMessageBudget(session)) {
        sendError(session, new GameError(ERROR_CODES.RATE_LIMITED, 'Message rate limit exceeded.'));
        socket.close(1008, 'Rate limit exceeded');
        return;
      }
      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) {
        sendError(session, new GameError(parsed.error.code, parsed.error.message));
        return;
      }
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
  }

  httpServer.on('upgrade', onUpgrade);
  wss.on('connection', onConnection);
  roomManager.on('message', onManagerMessage);
  roomManager.on('lobbyChanged', onLobbyChanged);
  roomManager.on('roomDestroyed', onRoomDestroyed);

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of authAttempts) {
      const current = attempts.filter((at) => at > now - authAttemptWindowMs);
      if (current.length) authAttempts.set(ip, current);
      else authAttempts.delete(ip);
    }
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

  async function close({ code = 1012, reason = 'Server restarting' } = {}) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    httpServer.off('upgrade', onUpgrade);
    roomManager.off('message', onManagerMessage);
    roomManager.off('lobbyChanged', onLobbyChanged);
    roomManager.off('roomDestroyed', onRoomDestroyed);
    for (const session of sessions) session.socket.close(code, reason);
    await new Promise((resolve) => wss.close(resolve));
  }

  return {
    wss,
    sessions,
    get connectionCount() { return sessions.size; },
    close,
  };
}
