import { validateDisplayName } from '../src/net/protocol.js';
import { USER_SESSION_COOKIE, sessionTokenFromRequest } from './user-store.js';

const MAX_BODY_BYTES = 4 * 1024;

function jsonResponse(res, statusCode, body, headers = {}) {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized),
    'Cache-Control': 'no-store',
    ...headers,
  }).end(serialized);
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
  constructor({ userStore, trustProxy = false } = {}) {
    if (!userStore) throw new TypeError('userStore is required.');
    this.userStore = userStore;
    this.trustProxy = trustProxy;
    this.sessionMaxAgeSeconds = Math.max(0, Math.trunc(userStore.sessionTtlMs / 1000));
  }

  _authenticated(req) {
    return this.userStore.resolveSession(sessionTokenFromRequest(req));
  }

  async handle(req, res, pathname) {
    if (pathname === '/api/user/session' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const token = sessionTokenFromRequest(req);
      const existing = this.userStore.resolveSession(token);
      const result = existing
        ? { ...existing, created: false, token: null }
        : this.userStore.createOrResumeSession({
          displayName: validatedDisplayName(body.displayName, { fallback: true }),
        });
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
