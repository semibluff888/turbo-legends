// Shared network telemetry overlay for menu/online screens and the in-race HUD.
// The browser fetches the game version from the server so package.json remains
// the single source of truth without exposing the package manifest itself.

const CONNECTION_LABELS = Object.freeze({
  connected: 'CONNECTED',
  connecting: 'CONNECTING',
  reconnecting: 'RECONNECTING',
  disconnected: 'OFFLINE',
  error: 'ERROR',
});

const CONNECTION_STATES = new Set(Object.keys(CONNECTION_LABELS));

export function latencyLevel(value) {
  if (value === null || value === undefined || value === '') return 'unknown';
  const latency = Number(value);
  if (!Number.isFinite(latency) || latency < 0) return 'unknown';
  if (latency <= 200) return 'good';
  if (latency <= 800) return 'warning';
  return 'bad';
}

export class NetworkStatus {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="network-summary">
        <span class="network-online" data-network-online>ONLINE PLAYERS —</span>
        <span class="network-separator" data-network-online-separator aria-hidden="true">·</span>
        <span class="network-connection" data-network-connection role="status" aria-live="polite">
          <span class="network-dot" aria-hidden="true"></span>
          <span data-network-state>OFFLINE</span>
        </span>
        <span class="network-separator" aria-hidden="true">·</span>
        <span class="network-latency" data-network-latency data-level="unknown">— ms</span>
      </div>
      <div class="game-version" data-game-version>VERSION —</div>
    `;

    const q = (selector) => root.querySelector(selector);
    this._summary = q('.network-summary');
    this._connection = q('[data-network-connection]');
    this._state = q('[data-network-state]');
    this._online = q('[data-network-online]');
    this._onlineSeparator = q('[data-network-online-separator]');
    this._latency = q('[data-network-latency]');
    this._version = q('[data-game-version]');
    this._connectionState = 'disconnected';
    this.setConnectionState('disconnected');
  }

  showDetails() {
    this.root.dataset.context = 'details';
    this.root.hidden = false;
    this._summary.hidden = false;
    this._online.hidden = false;
    this._onlineSeparator.hidden = false;
    this._version.hidden = false;
  }

  showRace() {
    this.root.dataset.context = 'race';
    this.root.hidden = false;
    this._summary.hidden = false;
    this._online.hidden = true;
    this._onlineSeparator.hidden = true;
    this._version.hidden = true;
  }

  showVersion() {
    this.root.dataset.context = 'version';
    this.root.hidden = false;
    this._summary.hidden = true;
    this._version.hidden = false;
  }

  hide() {
    this.root.hidden = true;
  }

  setConnectionState(state) {
    const normalized = state === 'idle' ? 'disconnected' : String(state || 'disconnected');
    this._connectionState = CONNECTION_STATES.has(normalized) ? normalized : 'disconnected';
    this._connection.dataset.state = this._connectionState;
    this._state.textContent = CONNECTION_LABELS[this._connectionState];
    if (this._connectionState !== 'connected') {
      this.setMetrics({ latencyMs: null, onlineCount: null });
    }
  }

  setMetrics({ latencyMs = null, onlineCount = null } = {}) {
    const level = this._connectionState === 'connected' ? latencyLevel(latencyMs) : 'unknown';
    const latency = level === 'unknown' ? null : Math.round(Number(latencyMs));
    const hasCount = onlineCount !== null && onlineCount !== undefined && onlineCount !== '';
    const count = this._connectionState === 'connected' && hasCount
      && Number.isFinite(Number(onlineCount)) && Number(onlineCount) >= 0
      ? Math.trunc(Number(onlineCount))
      : null;
    this._latency.dataset.level = level;
    this._latency.textContent = latency === null ? '— ms' : `${latency} ms`;
    this._online.textContent = count === null ? 'ONLINE PLAYERS —' : `ONLINE PLAYERS ${count}`;
  }

  setVersion(version) {
    const value = String(version || '').trim();
    this._version.textContent = value ? `VERSION ${value}` : 'VERSION —';
  }

  async loadVersion(fetchImpl = globalThis.fetch) {
    this.setVersion(null);
    if (typeof fetchImpl !== 'function') return null;
    try {
      const response = await fetchImpl('/api/meta', { cache: 'no-store' });
      if (!response?.ok) return null;
      const metadata = await response.json();
      const version = String(metadata?.version || '').trim();
      if (!version) return null;
      this.setVersion(version);
      return version;
    } catch {
      return null;
    }
  }
}
