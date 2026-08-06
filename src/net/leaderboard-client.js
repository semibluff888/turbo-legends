export const DEFAULT_LEADERBOARD_TTL_MS = 60 * 1000;

async function responseJson(response) {
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error?.message || 'The leaderboard request failed.');
    error.code = body?.error?.code || 'leaderboard_unavailable';
    error.status = response.status;
    throw error;
  }
  if (!body || typeof body !== 'object') {
    const error = new Error('The leaderboard response was invalid.');
    error.code = 'leaderboard_invalid';
    throw error;
  }
  return body;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

export class LeaderboardClient {
  constructor({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    defaultTtlMs = DEFAULT_LEADERBOARD_TTL_MS,
  } = {}) {
    this.fetchImpl = fetchImpl?.bind?.(globalThis) ?? fetchImpl;
    this.now = now;
    this.defaultTtlMs = positiveInteger(defaultTtlMs, DEFAULT_LEADERBOARD_TTL_MS);
    this.snapshot = null;
    this.freshUntil = 0;
    this.request = null;
  }

  load({ force = false } = {}) {
    const now = this.now();
    if (!force && this.snapshot && now < this.freshUntil) {
      return Promise.resolve(this.snapshot);
    }
    if (this.request) return this.request;

    const request = (async () => {
      const response = await this.fetchImpl('/api/leaderboards', {
        credentials: 'same-origin',
        cache: force ? 'reload' : 'default',
        headers: { Accept: 'application/json' },
      });
      const snapshot = await responseJson(response);
      const receivedAt = this.now();
      const ttlMs = positiveInteger(snapshot.ttlMs, this.defaultTtlMs);
      this.snapshot = snapshot;
      this.freshUntil = receivedAt + ttlMs;
      return snapshot;
    })();
    this.request = request;
    const clearRequest = () => {
      if (this.request === request) this.request = null;
    };
    request.then(clearRequest, clearRequest);
    return request;
  }
}
