import { createHash } from 'node:crypto';

import { validateDisplayName } from '../src/net/protocol.js';
import { USER_SESSION_COOKIE, sessionTokenFromRequest } from './user-store.js';

const MAX_BODY_BYTES = 4 * 1024;
export const DEFAULT_GUEST_CREATION_LIMIT = 0;
export const DEFAULT_GUEST_CREATION_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_LEADERBOARD_CACHE_TTL_MS = 60 * 1000;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function clientAddress(req, trustProxy) {
  const forwarded = trustProxy ? req.headers['x-forwarded-for'] : null;
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

function jsonResponse(res, statusCode, body, headers = {}) {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    ...headers,
  }).end(serialized);
}

function requestAcceptsEtag(value, etag) {
  return String(value || '')
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//u, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}

function requestIsSecure(req, trustProxy) {
  if (req.socket?.encrypted) return true;
  if (!trustProxy) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function sessionCookie(token, { secure = false, maxAgeSeconds = 365 * 24 * 60 * 60 } = {}) {
  return [
    `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new Error('Request body must be a JSON object.');
    error.statusCode = 400;
    error.code = 'invalid_json';
    throw error;
  }
}

function validatedDisplayName(value, { fallback = false } = {}) {
  const result = validateDisplayName(value ?? (fallback ? 'Racer' : value));
  if (result.ok) return result.value;
  const error = new Error(result.error.message);
  error.statusCode = 400;
  error.code = result.error.code;
  throw error;
}

export class UserHttpApi {
  constructor({
    userStore,
    trustProxy = false,
    guestCreationLimit = DEFAULT_GUEST_CREATION_LIMIT,
    guestCreationWindowMs = DEFAULT_GUEST_CREATION_WINDOW_MS,
    leaderboardCacheTtlMs = DEFAULT_LEADERBOARD_CACHE_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!userStore) throw new TypeError('userStore is required.');
    this.userStore = userStore;
    this.trustProxy = trustProxy;
    this.guestCreationLimit = nonNegativeInteger(
      guestCreationLimit,
      DEFAULT_GUEST_CREATION_LIMIT,
    );
    this.guestCreationWindowMs = positiveInteger(
      guestCreationWindowMs,
      DEFAULT_GUEST_CREATION_WINDOW_MS,
    );
    this.leaderboardCacheTtlMs = positiveInteger(
      leaderboardCacheTtlMs,
      DEFAULT_LEADERBOARD_CACHE_TTL_MS,
    );
    this.now = now;
    this.guestCreationAttempts = new Map();
    this.lastGuestCreationSweepAt = this.now();
    this.sessionMaxAgeSeconds = Math.max(0, Math.trunc(userStore.sessionTtlMs / 1000));
    this.leaderboardCache = null;
    this.leaderboardRefreshPromise = null;
  }

  _authenticated(req) {
    return this.userStore.resolveSession(sessionTokenFromRequest(req));
  }

  _consumeGuestCreation(req) {
    if (this.guestCreationLimit === 0) return true;
    const now = this.now();
    if (now - this.lastGuestCreationSweepAt >= this.guestCreationWindowMs) {
      for (const [ip, entry] of this.guestCreationAttempts) {
        if (entry.resetAt <= now) this.guestCreationAttempts.delete(ip);
      }
      this.lastGuestCreationSweepAt = now;
    }
    const ip = clientAddress(req, this.trustProxy);
    const existing = this.guestCreationAttempts.get(ip);
    if (!existing || existing.resetAt <= now) {
      this.guestCreationAttempts.set(ip, {
        count: 1,
        resetAt: now + this.guestCreationWindowMs,
      });
      return true;
    }
    if (existing.count >= this.guestCreationLimit) return false;
    existing.count++;
    return true;
  }

  async _leaderboardSnapshot() {
    const now = this.now();
    if (this.leaderboardCache && now < this.leaderboardCache.expiresAt) {
      return this.leaderboardCache;
    }
    if (this.leaderboardRefreshPromise) return this.leaderboardRefreshPromise;

    const refresh = Promise.resolve().then(() => {
      const generatedAt = this.now();
      const body = {
        generatedAt,
        ttlMs: this.leaderboardCacheTtlMs,
        ...this.userStore.getLeaderboards(10),
      };
      const serialized = JSON.stringify(body);
      const etag = `"${createHash('sha256').update(serialized).digest('base64url')}"`;
      const snapshot = {
        body,
        serialized,
        etag,
        expiresAt: generatedAt + this.leaderboardCacheTtlMs,
      };
      this.leaderboardCache = snapshot;
      return snapshot;
    });
    this.leaderboardRefreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.leaderboardRefreshPromise === refresh) this.leaderboardRefreshPromise = null;
    }
  }

  _sendLeaderboardSnapshot(req, res, snapshot) {
    const maxAgeSeconds = Math.max(0, Math.floor(this.leaderboardCacheTtlMs / 1000));
    const headers = {
      'Cache-Control': `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 5}`,
      ETag: snapshot.etag,
    };
    if (requestAcceptsEtag(req.headers['if-none-match'], snapshot.etag)) {
      res.writeHead(304, headers).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(snapshot.serialized),
      ...headers,
    }).end(snapshot.serialized);
  }

  async handle(req, res, pathname) {
    if (pathname === '/api/leaderboards' && req.method === 'GET') {
      this._sendLeaderboardSnapshot(req, res, await this._leaderboardSnapshot());
      return true;
    }

    if (pathname === '/api/user/session' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const token = sessionTokenFromRequest(req);
      const existing = this.userStore.resolveSession(token);
      let result;
      if (existing) {
        result = { ...existing, created: false, token: null };
      } else {
        const displayName = validatedDisplayName(body.displayName, { fallback: true });
        if (!this._consumeGuestCreation(req)) {
          const error = new Error('Too many guest accounts were created. Try again later.');
          error.statusCode = 429;
          error.code = 'rate_limited';
          throw error;
        }
        result = this.userStore.createOrResumeSession({ displayName });
      }
      const headers = result.token ? {
        'Set-Cookie': sessionCookie(result.token, {
          secure: requestIsSecure(req, this.trustProxy),
          maxAgeSeconds: this.sessionMaxAgeSeconds,
        }),
      } : {};
      jsonResponse(res, 200, result.profile, headers);
      return true;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const auth = this._authenticated(req);
      if (!auth) {
        jsonResponse(res, 401, { error: { code: 'authentication_required', message: 'Enter multiplayer again.' } });
      } else {
        jsonResponse(res, 200, auth.profile);
      }
      return true;
    }

    if (pathname === '/api/me' && req.method === 'PATCH') {
      const auth = this._authenticated(req);
      if (!auth) {
        jsonResponse(res, 401, { error: { code: 'authentication_required', message: 'Enter multiplayer again.' } });
        return true;
      }
      const body = await readJsonBody(req);
      const displayName = validatedDisplayName(body.displayName);
      jsonResponse(res, 200, this.userStore.updateDisplayName(auth.userId, displayName));
      return true;
    }
    return false;
  }

  async dispatch(req, res, pathname) {
    try {
      return await this.handle(req, res, pathname);
    } catch (error) {
      jsonResponse(res, error.statusCode || 500, {
        error: {
          code: error.code || 'internal_error',
          message: error.statusCode ? error.message : 'The user service could not complete the request.',
        },
      });
      return true;
    }
  }
}
