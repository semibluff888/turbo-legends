import { performance } from 'node:perf_hooks';

const RECENT_WINDOW_MS = 60_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const MAX_WINDOW_SAMPLES = 120_000;

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarizeSamples(samples, now, windowMs = RECENT_WINDOW_MS) {
  const cutoff = now - windowMs;
  while (samples.length && samples[0].at < cutoff) samples.shift();
  const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
  if (!values.length) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values[values.length - 1],
  };
}

function createTrafficDirection() {
  return { count: 0, bytes: 0, byType: Object.create(null) };
}

function cloneTraffic(direction) {
  return {
    count: direction.count,
    bytes: direction.bytes,
    byType: Object.fromEntries(Object.entries(direction.byType).map(([type, value]) => [
      type,
      { count: value.count, bytes: value.bytes },
    ])),
  };
}

/**
 * Zero-dependency process and multiplayer metrics collector.
 *
 * It intentionally accepts only aggregate names and numbers. Callers must not
 * attach room codes, nicknames, addresses, credentials, or resume tokens.
 */
export class RuntimeMetrics {
  constructor({
    logger = console,
    now = () => Date.now(),
    logIntervalMs = Number(process.env.METRICS_LOG_INTERVAL_MS) || 60_000,
    sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  } = {}) {
    this.logger = logger;
    this.now = now;
    this.startedAt = now();
    this.counters = {
      tick: {
        count: 0,
        busySkipped: 0,
        catchUpSteps: 0,
        catchUpCapped: 0,
        roomErrors: 0,
      },
      snapshot: {
        built: 0,
        sent: 0,
        bytes: 0,
        backpressureSkipped: 0,
        noReceiversSkipped: 0,
        slowConnectionsClosed: 0,
      },
      lobby: {
        builds: 0,
        broadcasts: 0,
        recipients: 0,
        bytes: 0,
      },
      auth: {
        attempts: 0,
        rateLimited: 0,
        queueRejected: 0,
        scryptCompleted: 0,
      },
      codec: {
        snapshotEncoded: 0,
        inputDecoded: 0,
        errors: 0,
        oversized: 0,
        v3Rejected: 0,
        invalidBinary: 0,
      },
      user: {
        startErrors: 0,
        settlementErrors: 0,
        settlementRetries: 0,
      },
    };
    this.traffic = {
      inbound: createTrafficDirection(),
      outbound: createTrafficDirection(),
    };
    this.samples = {
      eventLoopDelayMs: [],
      tickDurationMs: [],
      snapshotBytes: [],
      snapshotEncodeDurationMs: [],
      inputDecodeDurationMs: [],
      scryptDurationMs: [],
    };
    this._lastCpu = process.cpuUsage();
    this._lastCpuAt = performance.now();
    this._cpuPercent = 0;
    this._expectedSampleAt = performance.now() + sampleIntervalMs;
    this._sampleTimer = setInterval(() => this._sampleProcess(sampleIntervalMs), sampleIntervalMs);
    this._sampleTimer.unref?.();
    this._logTimer = null;
    if (finiteNonNegative(logIntervalMs) > 0) {
      this._logTimer = setInterval(() => {
        this.logger.info?.(`[multiplayer_metrics] ${JSON.stringify(this.snapshot())}`);
      }, logIntervalMs);
      this._logTimer.unref?.();
    }
  }

  _sampleProcess(sampleIntervalMs) {
    const currentAt = performance.now();
    this.observe('eventLoopDelayMs', Math.max(0, currentAt - this._expectedSampleAt));
    this._expectedSampleAt = currentAt + sampleIntervalMs;

    const cpu = process.cpuUsage();
    const elapsedMicros = Math.max(1, (currentAt - this._lastCpuAt) * 1000);
    const usedMicros = Math.max(0,
      (cpu.user - this._lastCpu.user) + (cpu.system - this._lastCpu.system));
    this._cpuPercent = usedMicros / elapsedMicros * 100;
    this._lastCpu = cpu;
    this._lastCpuAt = currentAt;
  }

  increment(group, name, amount = 1) {
    const target = this.counters[group];
    if (!target || !Object.hasOwn(target, name)) return;
    target[name] += finiteNonNegative(amount);
  }

  observe(name, value) {
    const samples = this.samples[name];
    const number = finiteNonNegative(value, NaN);
    if (!samples || !Number.isFinite(number)) return;
    samples.push({ at: this.now(), value: number });
    if (samples.length > MAX_WINDOW_SAMPLES) {
      samples.splice(0, samples.length - MAX_WINDOW_SAMPLES);
    }
  }

  recordTraffic(direction, type, bytes) {
    const target = this.traffic[direction];
    if (!target) return;
    const safeType = typeof type === 'string' && type ? type : 'unknown';
    const safeBytes = finiteNonNegative(bytes);
    target.count++;
    target.bytes += safeBytes;
    const entry = target.byType[safeType] ??= { count: 0, bytes: 0 };
    entry.count++;
    entry.bytes += safeBytes;
  }

  recordTick({
    durationMs = 0,
    busySkipped = false,
    catchUpSteps = 0,
    catchUpCapped = false,
    roomErrors = 0,
  } = {}) {
    this.increment('tick', 'count');
    if (busySkipped) this.increment('tick', 'busySkipped');
    this.increment('tick', 'catchUpSteps', catchUpSteps);
    this.increment('tick', 'catchUpCapped', typeof catchUpCapped === 'number' ? catchUpCapped : (
      catchUpCapped ? 1 : 0
    ));
    this.increment('tick', 'roomErrors', roomErrors);
    this.observe('tickDurationMs', durationMs);
  }

  recordSnapshot({ bytes = 0, built = true, sent = 0 } = {}) {
    if (built) {
      this.increment('snapshot', 'built');
      this.observe('snapshotBytes', bytes);
    }
    this.increment('snapshot', 'sent', sent);
    this.increment('snapshot', 'bytes', finiteNonNegative(bytes) * finiteNonNegative(sent));
  }

  recordScrypt(durationMs) {
    this.increment('auth', 'scryptCompleted');
    this.observe('scryptDurationMs', durationMs);
  }

  recordSnapshotEncoding({ durationMs = 0 } = {}) {
    this.increment('codec', 'snapshotEncoded');
    this.observe('snapshotEncodeDurationMs', durationMs);
  }

  recordInputDecode(durationMs) {
    this.increment('codec', 'inputDecoded');
    this.observe('inputDecodeDurationMs', durationMs);
  }

  recordCodecError({ oversized = false, invalidBinary = false } = {}) {
    this.increment('codec', 'errors');
    if (oversized) this.increment('codec', 'oversized');
    if (invalidBinary) this.increment('codec', 'invalidBinary');
  }

  recordProtocolV3Rejected() {
    this.increment('codec', 'v3Rejected');
  }

  snapshot() {
    const at = this.now();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    return {
      generatedAt: at,
      windowMs: RECENT_WINDOW_MS,
      process: {
        uptimeSeconds: process.uptime(),
        cpu: {
          userMicros: cpu.user,
          systemMicros: cpu.system,
          percent: this._cpuPercent,
        },
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        eventLoopDelayMs: summarizeSamples(this.samples.eventLoopDelayMs, at),
      },
      tick: {
        ...this.counters.tick,
        durationMs: summarizeSamples(this.samples.tickDurationMs, at),
      },
      traffic: {
        inbound: cloneTraffic(this.traffic.inbound),
        outbound: cloneTraffic(this.traffic.outbound),
      },
      snapshot: {
        ...this.counters.snapshot,
        sizeBytes: summarizeSamples(this.samples.snapshotBytes, at),
      },
      lobby: { ...this.counters.lobby },
      backpressure: {
        snapshotSkipped: this.counters.snapshot.backpressureSkipped,
        slowConnectionsClosed: this.counters.snapshot.slowConnectionsClosed,
      },
      auth: {
        ...this.counters.auth,
        scryptDurationMs: summarizeSamples(this.samples.scryptDurationMs, at),
      },
      codec: {
        ...this.counters.codec,
        snapshotEncodeDurationMs: summarizeSamples(this.samples.snapshotEncodeDurationMs, at),
        inputDecodeDurationMs: summarizeSamples(this.samples.inputDecodeDurationMs, at),
      },
    };
  }

  close() {
    clearInterval(this._sampleTimer);
    if (this._logTimer) clearInterval(this._logTimer);
  }
}
