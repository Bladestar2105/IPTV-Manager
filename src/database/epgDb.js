import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DATA_DIR, EPG_DB_PATH } from '../config/constants.js';

// Ensure Data Directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(EPG_DB_PATH);
// Enable foreign keys
db.pragma('foreign_keys = ON');
// Performance tuning
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

export function initEpgDb() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS epg_channels (
        id TEXT NOT NULL,
        name TEXT,
        logo TEXT,
        source_type TEXT NOT NULL, -- 'provider' or 'custom'
        source_id INTEGER NOT NULL,
        updated_at INTEGER,
        PRIMARY KEY (id, source_type, source_id)
      );

      CREATE TABLE IF NOT EXISTS epg_programs (
        channel_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        title TEXT,
        desc TEXT,
        lang TEXT,
        PRIMARY KEY (channel_id, source_type, source_id, start),
        FOREIGN KEY (channel_id, source_type, source_id) REFERENCES epg_channels(id, source_type, source_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_epg_programs_stop ON epg_programs(stop);
      CREATE INDEX IF NOT EXISTS idx_epg_programs_channel_start ON epg_programs(channel_id, start);
      CREATE INDEX IF NOT EXISTS idx_epg_channels_id ON epg_channels(id);
    `);

    console.log("✅ EPG Database initialized");
  } catch (e) {
    console.error("❌ EPG DB Init Error:", e.message);
  }
}

export default db;
