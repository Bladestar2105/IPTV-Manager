export function migrateStalkerTables(db) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stalker_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mac TEXT NOT NULL COLLATE NOCASE UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        parental_pin_encrypted TEXT,
        serial_number TEXT,
        device_uid TEXT,
        model TEXT,
        last_ip TEXT,
        last_seen INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_stalker_devices_user
        ON stalker_devices(user_id);

      CREATE TABLE IF NOT EXISTS stalker_sessions (
        token TEXT PRIMARY KEY,
        device_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES stalker_devices(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_stalker_sessions_user
        ON stalker_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_stalker_sessions_expiry
        ON stalker_sessions(expires_at);
    `);

    const deviceColumns = db.prepare('PRAGMA table_info(stalker_devices)').all();
    if (!deviceColumns.some(column => column.name === 'parental_pin_encrypted')) {
      db.exec('ALTER TABLE stalker_devices ADD COLUMN parental_pin_encrypted TEXT');
    }

    const authorizationView = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'view' AND name = 'authorized_user_channels'
    `).get();
    if (!authorizationView) {
      throw new Error('Stalker/MAG requires the authorized_user_channels authorization view');
    }
  });

  migrate();
}
