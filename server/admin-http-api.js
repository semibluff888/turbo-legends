import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { parseCookies } from './user-store.js';
import {
  clientAddress,
  requestIsSameOrigin,
  requestIsSecure,
} from './http-request-utils.js';

export const ADMIN_SESSION_COOKIE = 'turbo_legends_admin';
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const ADMIN_LOGIN_FAILURE_LIMIT = 5;

const MAX_BODY_BYTES = 4 * 1024;

function tokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function jsonResponse(response, statusCode, body, headers = {}) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    ...headers,
  }).end(serialized);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
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

function adminCookie(token, { secure = false, maxAgeSeconds = ADMIN_SESSION_TTL_MS / 1000 } = {}) {
  return [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.trunc(number));
}

export class AdminHttpApi {
  constructor({
    adminKey,
    userStore,
    analytics,
    trustProxy = false,
    logger = console,
    now = () => Date.now(),
    sessionTokenFactory = () => randomBytes(32).toString('base64url'),
    isUserActive = () => false,
    currentOnline = () => 0,
    invalidateLeaderboards = () => {},
    getServerSettings = () => ({ botRoomEnabled: true, source: 'default', updatedAt: null }),
    updateServerSettings = null,
  } = {}) {
    if (typeof adminKey !== 'string' || adminKey.length < 16) {
      throw new TypeError('ADMIN_KEY must contain at least 16 characters.');
    }
    if (!userStore || !analytics) throw new TypeError('userStore and analytics are required.');
    this.expectedKeyHash = createHash('sha256').update(adminKey).digest();
    this.userStore = userStore;
    this.analytics = analytics;
    this.trustProxy = trustProxy;
    this.logger = logger;
    this.now = now;
    this.sessionTokenFactory = sessionTokenFactory;
    this.isUserActive = isUserActive;
    this.currentOnline = currentOnline;
    this.invalidateLeaderboards = invalidateLeaderboards;
    this.getServerSettings = getServerSettings;
    this.updateServerSettings = updateServerSettings;
    this.sessions = new Map();
    this.loginFailures = new Map();
  }

  _sameOriginJson(request) {
    return requestIsSameOrigin(request)
      && String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json');
  }

  _authenticated(request) {
    const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE) || '';
    if (!token) return null;
    const hash = tokenHash(token);
    const session = this.sessions.get(hash);
    const now = this.now();
    if (!session || session.expiresAt <= now) {
      if (session) this.sessions.delete(hash);
      return null;
    }
    return session;
  }

  _requireAuthenticated(request) {
    const session = this._authenticated(request);
    if (session) return session;
    const error = new Error('Administrator authentication is required.');
    error.statusCode = 401;
    error.code = 'authentication_required';
    throw error;
  }

  _requireSameOriginJson(request) {
    if (this._sameOriginJson(request)) return;
    const error = new Error('Administrative writes require same-origin JSON requests.');
    error.statusCode = 403;
    error.code = 'origin_invalid';
    throw error;
  }

  _consumeLoginFailure(request) {
    const now = this.now();
    const cutoff = now - ADMIN_LOGIN_WINDOW_MS;
    const address = clientAddress(request, this.trustProxy);
    const attempts = (this.loginFailures.get(address) ?? []).filter((at) => at > cutoff);
    attempts.push(now);
    this.loginFailures.set(address, attempts);
    return attempts.length <= ADMIN_LOGIN_FAILURE_LIMIT;
  }

  _loginAllowed(request) {
    const now = this.now();
    const cutoff = now - ADMIN_LOGIN_WINDOW_MS;
    const address = clientAddress(request, this.trustProxy);
    const attempts = (this.loginFailures.get(address) ?? []).filter((at) => at > cutoff);
    if (attempts.length) this.loginFailures.set(address, attempts);
    else this.loginFailures.delete(address);
    return attempts.length < ADMIN_LOGIN_FAILURE_LIMIT;
  }

  _keyMatches(value) {
    const candidate = createHash('sha256').update(String(value || '')).digest();
    return timingSafeEqual(candidate, this.expectedKeyHash);
  }

  async handle(request, response, pathname) {
    if (!pathname.startsWith('/api/admin/')) return false;

    if (pathname === '/api/admin/login' && request.method === 'POST') {
      this._requireSameOriginJson(request);
      if (!this._loginAllowed(request)) {
        jsonResponse(response, 429, {
          error: { code: 'rate_limited', message: 'Too many failed login attempts.' },
        });
        return true;
      }
      const body = await readJsonBody(request);
      if (!this._keyMatches(body.key)) {
        const stillAllowed = this._consumeLoginFailure(request);
        jsonResponse(response, stillAllowed ? 401 : 429, {
          error: {
            code: stillAllowed ? 'authentication_failed' : 'rate_limited',
            message: stillAllowed ? 'The administrator key is invalid.' : 'Too many failed login attempts.',
          },
        });
        return true;
      }
      const token = this.sessionTokenFactory();
      const expiresAt = this.now() + ADMIN_SESSION_TTL_MS;
      this.sessions.set(tokenHash(token), { expiresAt });
      this.loginFailures.delete(clientAddress(request, this.trustProxy));
      jsonResponse(response, 200, { authenticated: true, expiresAt }, {
        'Set-Cookie': adminCookie(token, {
          secure: requestIsSecure(request, this.trustProxy),
        }),
      });
      return true;
    }

    if (pathname === '/api/admin/logout' && request.method === 'POST') {
      this._requireSameOriginJson(request);
      const token = parseCookies(request.headers.cookie).get(ADMIN_SESSION_COOKIE) || '';
      if (token) this.sessions.delete(tokenHash(token));
      jsonResponse(response, 200, { authenticated: false }, {
        'Set-Cookie': adminCookie('', { maxAgeSeconds: 0 }),
      });
      return true;
    }

    this._requireAuthenticated(request);

    if (pathname === '/api/admin/settings' && request.method === 'GET') {
      jsonResponse(response, 200, this.getServerSettings());
      return true;
    }

    if (pathname === '/api/admin/settings' && request.method === 'PATCH') {
      this._requireSameOriginJson(request);
      const body = await readJsonBody(request);
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'botRoomEnabled'
        || typeof body.botRoomEnabled !== 'boolean') {
        jsonResponse(response, 400, {
          error: {
            code: 'settings_invalid',
            message: 'Only a strict botRoomEnabled boolean is accepted.',
          },
        });
        return true;
      }
      if (typeof this.updateServerSettings !== 'function') {
        jsonResponse(response, 503, {
          error: { code: 'settings_unavailable', message: 'Server settings are unavailable.' },
        });
        return true;
      }
      jsonResponse(response, 200, this.updateServerSettings({
        botRoomEnabled: body.botRoomEnabled,
      }));
      return true;
    }

    if (pathname === '/api/admin/dashboard' && request.method === 'GET') {
      const url = new URL(request.url, 'http://localhost');
      const range = url.searchParams.get('range') || '24h';
      const dashboard = this.analytics.getDashboard(range, {
        userCount: this.userStore.countUsers(),
        currentOnline: this.currentOnline(),
      });
      if (!dashboard) {
        jsonResponse(response, 400, {
          error: { code: 'range_invalid', message: 'Unknown dashboard range.' },
        });
      } else {
        jsonResponse(response, 200, dashboard);
      }
      return true;
    }

    if (pathname === '/api/admin/users' && request.method === 'GET') {
      const url = new URL(request.url, 'http://localhost');
      const query = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      const page = positiveInteger(url.searchParams.get('page'), 1, 1_000_000);
      const pageSize = positiveInteger(url.searchParams.get('pageSize'), 25, 100);
      const result = this.userStore.listAdminUsers({ query, page, pageSize });
      result.items = result.items.map((item) => ({
        ...item,
        active: Boolean(this.isUserActive(item.userId)),
      }));
      jsonResponse(response, 200, result);
      return true;
    }

    const userPath = /^\/api\/admin\/users\/([^/]+)$/u.exec(pathname);
    if (userPath && request.method === 'GET') {
      const userId = decodeURIComponent(userPath[1]);
      const detail = this.userStore.getAdminUser(userId);
      if (!detail) {
        jsonResponse(response, 404, {
          error: { code: 'user_not_found', message: 'The user does not exist.' },
        });
      } else {
        jsonResponse(response, 200, {
          ...detail,
          active: Boolean(this.isUserActive(userId)),
        });
      }
      return true;
    }

    if (userPath && request.method === 'DELETE') {
      this._requireSameOriginJson(request);
      const userId = decodeURIComponent(userPath[1]);
      if (this.isUserActive(userId)) {
        jsonResponse(response, 409, {
          error: { code: 'user_active', message: 'The user is still active or awaiting settlement.' },
        });
        return true;
      }
      const detail = this.userStore.getAdminUser(userId);
      if (!detail) {
        jsonResponse(response, 404, {
          error: { code: 'user_not_found', message: 'The user does not exist.' },
        });
        return true;
      }
      this.userStore.deleteUser(userId);
      this.invalidateLeaderboards();
      this.logger.info?.(`[admin] deleted user ${userId}`);
      jsonResponse(response, 200, { deleted: true, userId });
      return true;
    }

    jsonResponse(response, 404, {
      error: { code: 'not_found', message: 'Administrative endpoint not found.' },
    });
    return true;
  }

  async dispatch(request, response, pathname) {
    try {
      return await this.handle(request, response, pathname);
    } catch (error) {
      jsonResponse(response, error.statusCode || 500, {
        error: {
          code: error.code || 'internal_error',
          message: error.statusCode ? error.message : 'The administrative request failed.',
        },
      });
      return true;
    }
  }

  close() {
    this.sessions.clear();
    this.loginFailures.clear();
  }
}
