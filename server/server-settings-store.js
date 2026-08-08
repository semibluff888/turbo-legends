const BOT_ROOM_ENABLED_KEY = 'BOT_ROOM_ENABLED';

function storedBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** Small persistent store for administrator-controlled server settings. */
export class ServerSettingsStore {
  constructor({ db, now = () => Date.now() } = {}) {
    if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
      throw new TypeError('A SQLite database is required for server settings.');
    }
    this.db = db;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    this._read = this.db.prepare(`
      SELECT setting_value, updated_at
      FROM server_settings
      WHERE setting_key = ?
    `);
    this._write = this.db.prepare(`
      INSERT INTO server_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `);
  }

  getBotRoomEnabled(defaultValue = true, defaultSource = 'default') {
    const row = this._read.get(BOT_ROOM_ENABLED_KEY);
    const persisted = storedBoolean(row?.setting_value);
    if (persisted === null) {
      return {
        botRoomEnabled: Boolean(defaultValue),
        source: defaultSource === 'environment' ? 'environment' : 'default',
        updatedAt: null,
      };
    }
    return {
      botRoomEnabled: persisted,
      source: 'database',
      updatedAt: Number(row.updated_at) || null,
    };
  }

  setBotRoomEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('botRoomEnabled must be a boolean.');
    const updatedAt = this.now();
    this._write.run(BOT_ROOM_ENABLED_KEY, String(enabled), updatedAt);
    return { botRoomEnabled: enabled, source: 'database', updatedAt };
  }
}
