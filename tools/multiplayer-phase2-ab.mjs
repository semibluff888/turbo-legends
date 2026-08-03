// Local protocol v3/v4 A/B runner. The v3 server is extracted from the phase-2
// baseline commit into an OS temp directory; the main worktree is never reset
// or checked out. The v4 leg also runs for 60 seconds by default so memory
// samples can expose sustained growth.
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_COMMIT = process.env.PHASE2_BASELINE_COMMIT || '3d2506c';
const BASELINE_DURATION_MS = Math.max(5_000, Number(process.env.PHASE2_AB_BASELINE_MS) || 10_000);
const V4_DURATION_MS = Math.max(10_000, Number(process.env.PHASE2_AB_V4_MS) || 60_000);
const WARMUP_MS = Math.max(1_000, Number(process.env.PHASE2_AB_WARMUP_MS) || 2_000);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function percentileSummary(samples) {
  const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const at = percentile => values[Math.min(values.length - 1, Math.floor((values.length - 1) * percentile))] ?? 0;
  return {
    count: values.length,
    p50: at(0.50),
    p95: at(0.95),
    p99: at(0.99),
    max: values.at(-1) ?? 0,
  };
}

function linearSlope(samples, field) {
  if (samples.length < 2) return 0;
  const meanX = samples.reduce((sum, sample) => sum + sample.seconds, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const dx = sample.seconds - meanX;
    numerator += dx * (sample[field] - meanY);
    denominator += dx * dx;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function sampleRange(samples, field) {
  const values = samples.map(sample => sample[field]);
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function trafficDelta(after, before, direction, type = null) {
  const next = after.traffic[direction];
  const previous = before.traffic[direction];
  if (!type) return {
    count: next.count - previous.count,
    bytes: next.bytes - previous.bytes,
  };
  const nextType = next.byType[type] || { count: 0, bytes: 0 };
  const previousType = previous.byType[type] || { count: 0, bytes: 0 };
  return {
    count: nextType.count - previousType.count,
    bytes: nextType.bytes - previousType.bytes,
  };
}

class ABRaceSimulation {
  constructor({ roster, laps }) {
    this.state = 'racing';
    this.countdown = 0;
    this.elapsed = 0;
    this.laps = laps;
    this.controllers = roster.map(entry => entry.controllerKind);
    this.karts = roster.map(entry => ({
      index: entry.kartIndex,
      controllerKind: entry.controllerKind,
      x: entry.kartIndex * 2,
      y: 0,
      z: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      speed: 0,
      s: 0,
      progress: 0,
      lap: 1,
      rank: entry.kartIndex + 1,
      state: 'normal',
      surface: 'road',
      item: 'none',
      rouletteFace: 'banana',
      pendingItem: 'none',
      controls: { throttle: 0, brake: 0, steer: 0, drift: false, lookBack: false },
    }));
    this.items = { projectiles: [], hazards: [], drainVfx: () => [] };
    this.track = {
      itemBoxes: Array.from({ length: 24 }, (_, index) => ({
        active: index % 5 !== 0,
        respawnAt: index % 5 === 0 ? 4.5 + index * 0.01 : null,
      })),
    };
  }

  setController(index, kind) {
    this.controllers[index] = kind;
    this.karts[index].controllerKind = kind;
  }

  update(dt, inputs) {
    this.elapsed += dt;
    for (let index = 0; index < this.karts.length; index++) {
      const input = inputs[index];
      if (!input) continue;
      const kart = this.karts[index];
      kart.controls = input;
      kart.speed = input.throttle * 28;
      kart.x += kart.speed * dt;
      kart.s += kart.speed * dt;
      kart.progress += kart.speed * dt;
    }
  }
}

async function connectClient({ url, origin, protocolVersion, decodeSnapshot }) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  const messages = [];
  const waiters = [];
  const raceIds = new Map();
  socket.on('message', (data, isBinary) => {
    const message = isBinary
      ? decodeSnapshot(data)
      : JSON.parse(data.toString('utf8'));
    if (message.type === 'prepare_race' && message.wireRaceId) {
      raceIds.set(message.wireRaceId, message.raceId);
    } else if (message.type === 'snapshot') {
      message.raceId = raceIds.get(message.wireRaceId) ?? null;
    }
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (!waiters[index].predicate(message)) continue;
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
    if (messages.length > 16) messages.splice(0, messages.length - 16);
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen);
    socket.once('error', rejectOpen);
  });
  return {
    socket,
    send(message) {
      socket.send(JSON.stringify({ v: protocolVersion, ...message }));
    },
    next(predicate, timeoutMs = 5_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveNext, rejectNext) => {
        const waiter = { predicate, resolve: resolveNext, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectNext(new Error(
            `A/B client timed out waiting for a server message; received: ${messages.map(message => message.type).join(', ')}; errors: ${JSON.stringify(messages.filter(message => message.type === 'error'))}`,
          ));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async close() {
      if (socket.readyState >= WebSocket.CLOSING) return;
      await new Promise(resolveClose => {
        socket.once('close', resolveClose);
        socket.close(1000, 'A/B complete');
      });
    },
  };
}

async function runScenario(targetRoot, durationMs) {
  const moduleNonce = `${Date.now()}-${Math.random()}`;
  const serverModule = await import(`${pathToFileURL(join(targetRoot, 'server.mjs')).href}?ab=${moduleNonce}`);
  const protocolModule = await import(`${pathToFileURL(join(targetRoot, 'src/net/protocol.js')).href}?ab=${moduleNonce}`);
  const protocolVersion = protocolModule.PROTOCOL_VERSION;
  const codec = protocolVersion >= 4
    ? await import(`${pathToFileURL(join(targetRoot, 'src/net/binary-race-codec.js')).href}?ab=${moduleNonce}`)
    : null;
  // The A/B clients run in the same process as the server. Inspect only the
  // binary header here so client-side snapshot object churn does not pollute
  // the server memory-retention measurement.
  const decodeSnapshot = codec
    ? (data => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        v: protocolVersion,
        type: 'snapshot',
        wireRaceId: view.getUint32(8, true),
        tick: view.getUint32(12, true),
      };
    })
    : (data => JSON.parse(data.toString('utf8')));
  const server = await serverModule.createGameServer({
    root: targetRoot,
    logger: { info() {}, warn() {}, error() {} },
    metricsLogIntervalMs: 0,
    maintenanceIntervalMs: 20,
    roomManagerOptions: { raceFactory: async args => new ABRaceSimulation(args) },
    webSocketOptions: { lobbyBroadcastDebounceMs: 20, serverStatsDebounceMs: 10 },
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients = [];
  let inputTimer = null;
  let memoryTimer = null;
  try {
    for (let index = 0; index < 8; index++) {
      clients.push(await connectClient({ url, origin, protocolVersion, decodeSnapshot }));
    }
    const host = clients[0];
    host.send({
      type: 'create_room',
      displayName: 'AB Racer 1',
      roomName: `Protocol v${protocolVersion} A/B`,
      roomType: 'public',
      maxPlayers: 8,
    });
    const welcome = await host.next(message => message.type === 'welcome' && message.session);
    for (let index = 1; index < clients.length; index++) {
      clients[index].send({
        type: 'join_room',
        roomCode: welcome.roomCode,
        displayName: `AB Racer ${index + 1}`,
      });
      await clients[index].next(message => message.type === 'welcome' && message.session);
    }
    for (const client of clients) client.send({ type: 'set_ready', ready: true });
    await host.next(message => message.type === 'room_state' && message.canStart === true);
    host.send({ type: 'start_race' });
    const prepare = await host.next(message => message.type === 'prepare_race');
    await Promise.all(clients.slice(1).map(client => client.next(message => (
      message.type === 'prepare_race' && message.raceId === prepare.raceId
    ))));
    for (const client of clients) client.send({ type: 'race_loaded', raceId: prepare.raceId });
    await Promise.all(clients.map(client => client.next(message => message.type === 'snapshot')));

    let sequence = 0;
    const sendInputs = () => {
      sequence++;
      for (let index = 0; index < clients.length; index++) {
        const input = {
          seq: sequence,
          useItemSeq: sequence % 180 === 0 ? Math.floor(sequence / 180) : Math.max(0, Math.floor((sequence - 1) / 180)),
          throttle: 1,
          brake: 0,
          steer: index % 2 === 0 ? 0.25 : -0.25,
          drift: sequence % 120 < 30,
          lookBack: false,
        };
        if (protocolVersion >= 4) {
          clients[index].socket.send(codec.encodeInputPacket({
            wireRaceId: prepare.wireRaceId,
            ...input,
          }));
        } else {
          clients[index].send({ type: 'input', raceId: prepare.raceId, ...input });
        }
      }
    };
    inputTimer = setInterval(sendInputs, 1000 / 60);
    await delay(WARMUP_MS);
    if (globalThis.gc) globalThis.gc();
    const before = server.runtimeMetrics.snapshot();
    const startedAt = performance.now();
    const memorySamples = [];
    const sampleMemory = () => {
      if (globalThis.gc) globalThis.gc();
      const memory = process.memoryUsage();
      memorySamples.push({
        seconds: (performance.now() - startedAt) / 1000,
        rss: memory.rss,
        heap: memory.heapUsed,
        arrayBuffers: memory.arrayBuffers,
      });
    };
    sampleMemory();
    memoryTimer = setInterval(sampleMemory, 5_000);
    await delay(durationMs);
    clearInterval(memoryTimer);
    memoryTimer = null;
    sampleMemory();
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    const after = server.runtimeMetrics.snapshot();
    const inbound = trafficDelta(after, before, 'inbound');
    const outbound = trafficDelta(after, before, 'outbound');
    const inputs = trafficDelta(after, before, 'inbound', 'input');
    const snapshots = trafficDelta(after, before, 'outbound', 'snapshot');
    const snapshotBuilds = after.snapshot.built - before.snapshot.built;
    const stableMemorySamples = memorySamples.slice(Math.floor(memorySamples.length / 3));
    const tailMemorySamples = memorySamples.slice(-Math.min(4, memorySamples.length));
    return {
      protocolVersion,
      durationSeconds: elapsedSeconds,
      tick: {
        count: after.tick.count - before.tick.count,
        p99Ms: after.tick.durationMs.p99,
        catchUpCapped: after.tick.catchUpCapped - before.tick.catchUpCapped,
        roomErrors: after.tick.roomErrors - before.tick.roomErrors,
      },
      snapshot: {
        builds: snapshotBuilds,
        hz: snapshotBuilds / elapsedSeconds,
        averageWireBytes: snapshots.count > 0 ? snapshots.bytes / snapshots.count : 0,
      },
      input: {
        count: inputs.count,
        averageWireBytes: inputs.count > 0 ? inputs.bytes / inputs.count : 0,
      },
      totalWireBytesPerSecond: (inbound.bytes + outbound.bytes) / elapsedSeconds,
      codecErrors: after.codec?.errors ?? 0,
      memory: {
        samples: memorySamples.length,
        rssSlopeBytesPerSecond: linearSlope(stableMemorySamples, 'rss'),
        heapSlopeBytesPerSecond: linearSlope(stableMemorySamples, 'heap'),
        arrayBuffersSlopeBytesPerSecond: linearSlope(stableMemorySamples, 'arrayBuffers'),
        tailRssRangeBytes: sampleRange(tailMemorySamples, 'rss'),
        tailHeapRangeBytes: sampleRange(tailMemorySamples, 'heap'),
        tailArrayBuffersRangeBytes: sampleRange(tailMemorySamples, 'arrayBuffers'),
        rss: percentileSummary(memorySamples.map(sample => sample.rss)),
        heap: percentileSummary(memorySamples.map(sample => sample.heap)),
        arrayBuffers: percentileSummary(memorySamples.map(sample => sample.arrayBuffers)),
      },
    };
  } finally {
    if (inputTimer) clearInterval(inputTimer);
    if (memoryTimer) clearInterval(memoryTimer);
    await Promise.allSettled(clients.map(client => client.close()));
    await server.shutdown();
  }
}

async function extractBaseline() {
  await execFileAsync('git', ['cat-file', '-e', `${BASELINE_COMMIT}^{commit}`], { cwd: ROOT });
  const tempRoot = await mkdtemp(join(tmpdir(), 'turbo-legends-phase2-ab-'));
  const archivePath = join(tempRoot, 'baseline.tar');
  const baselineRoot = join(tempRoot, 'baseline');
  await mkdir(baselineRoot);
  await execFileAsync('git', [
    'archive', '--format=tar', `--output=${archivePath}`, BASELINE_COMMIT,
  ], { cwd: ROOT });
  await execFileAsync('tar', ['-xf', archivePath, '-C', baselineRoot]);
  await mkdir(join(baselineRoot, 'node_modules'));
  await cp(join(ROOT, 'node_modules', 'ws'), join(baselineRoot, 'node_modules', 'ws'), { recursive: true });
  return { tempRoot, baselineRoot };
}

let extracted;
try {
  extracted = await extractBaseline();
  const baseline = await runScenario(extracted.baselineRoot, BASELINE_DURATION_MS);
  const current = await runScenario(ROOT, V4_DURATION_MS);
  const snapshotReduction = 1 - current.snapshot.averageWireBytes / baseline.snapshot.averageWireBytes;
  const inputReduction = 1 - current.input.averageWireBytes / baseline.input.averageWireBytes;
  const totalWireReduction = 1 - current.totalWireBytesPerSecond / baseline.totalWireBytesPerSecond;
  const tickP99DeltaMs = current.tick.p99Ms - baseline.tick.p99Ms;
  const checks = {
    baselineIsV3: baseline.protocolVersion === 3,
    currentIsV4: current.protocolVersion === 4,
    standardSnapshotAtMost1536Bytes: current.snapshot.averageWireBytes <= 1_536,
    fixedInputIs28Bytes: current.input.averageWireBytes === 28,
    totalWireReductionAtLeast50Percent: totalWireReduction >= 0.50,
    tickP99DeltaAtMostPoint2Ms: tickP99DeltaMs <= 0.2,
    snapshotRateInRange: current.snapshot.hz >= 19.5 && current.snapshot.hz <= 20.5,
    schedulerClean: current.tick.catchUpCapped === 0 && current.tick.roomErrors === 0,
    codecClean: current.codecErrors === 0,
    memoryNotLinear: current.memory.tailRssRangeBytes <= 4 * 1024 * 1024
      && current.memory.tailHeapRangeBytes <= 1024 * 1024
      && current.memory.tailArrayBuffersRangeBytes <= 256 * 1024,
  };
  const result = {
    baselineCommit: BASELINE_COMMIT,
    baseline,
    current,
    comparison: {
      snapshotReductionPercent: snapshotReduction * 100,
      inputReductionPercent: inputReduction * 100,
      totalWireReductionPercent: totalWireReduction * 100,
      tickP99DeltaMs,
    },
    checks,
  };
  console.log(JSON.stringify(result));
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally {
  if (extracted?.tempRoot) await rm(extracted.tempRoot, { recursive: true, force: true });
}
