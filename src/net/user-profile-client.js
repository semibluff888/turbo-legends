function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function responseJson(response) {
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error?.message || 'The user service request failed.');
    error.code = body?.error?.code || 'user_service_error';
    error.status = response.status;
    throw error;
  }
  return body;
}

export class UserProfileClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl?.bind?.(globalThis) ?? fetchImpl;
    this.profile = null;
  }

  async bootstrap(displayName) {
    const response = await this.fetchImpl('/api/user/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName }),
    });
    this.profile = await responseJson(response);
    return this.profile;
  }

  async load() {
    const response = await this.fetchImpl('/api/me', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    this.profile = await responseJson(response);
    return this.profile;
  }

  async updateDisplayName(displayName) {
    const response = await this.fetchImpl('/api/me', {
      method: 'PATCH',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName }),
    });
    this.profile = await responseJson(response);
    return this.profile;
  }
}
