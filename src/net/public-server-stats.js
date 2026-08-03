export const PUBLIC_STATS_INTERVAL_MS = 15_000;

/** Polls aggregate server reachability without creating a WebSocket. */
export class PublicServerStatsPoller {
  constructor({
    fetchImpl = globalThis.fetch,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    intervalMs = PUBLIC_STATS_INTERVAL_MS,
    onUpdate = () => {},
  } = {}) {
    this.fetchImpl = fetchImpl;
    this._setTimeout = setTimeoutImpl.bind(globalThis);
    this._clearTimeout = clearTimeoutImpl.bind(globalThis);
    this.now = now;
    this.intervalMs = intervalMs;
    this.onUpdate = onUpdate;
    this.running = false;
    this.timer = null;
    this.generation = 0;
  }

  start() {
    if (this.running) return false;
    this.running = true;
    const generation = ++this.generation;
    void this._poll(generation);
    return true;
  }

  stop() {
    if (!this.running && this.timer == null) return false;
    this.running = false;
    this.generation++;
    if (this.timer != null) this._clearTimeout(this.timer);
    this.timer = null;
    return true;
  }

  async _poll(generation) {
    const startedAt = this.now();
    let update = { available: false, latencyMs: null, onlineCount: null, version: null };
    try {
      if (typeof this.fetchImpl !== 'function') throw new Error('Fetch is unavailable.');
      const response = await this.fetchImpl('/api/stats');
      if (!response?.ok) throw new Error('Stats request failed.');
      const body = await response.json();
      const count = Number(body?.onlineCount);
      update = {
        available: true,
        latencyMs: Math.max(0, Math.round(this.now() - startedAt)),
        onlineCount: Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null,
        version: typeof body?.version === 'string' ? body.version : null,
      };
    } catch {
      // Offline is an expected state on title/single-player screens.
    }
    if (!this.running || generation !== this.generation) return;
    this.onUpdate(update);
    this.timer = this._setTimeout(() => {
      this.timer = null;
      void this._poll(generation);
    }, this.intervalMs);
  }
}

