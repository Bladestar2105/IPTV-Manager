import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Go up two levels from src/config to root
const rootDir = path.resolve(__dirname, '../../');
const dbPath = path.join(rootDir, 'db.sqlite');

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

export function initDatabase() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        epg_url TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS provider_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        remote_stream_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        original_category_id INTEGER DEFAULT 0,
        logo TEXT DEFAULT '',
        stream_type TEXT DEFAULT 'live',
        epg_channel_id TEXT DEFAULT '',
        UNIQUE(provider_id, remote_stream_id)
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS user_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_adult INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_category_id INTEGER NOT NULL,
        provider_channel_id INTEGER NOT NULL,
        sort_order INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sync_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL UNIQUE,
        user_id INTEGER NOT NULL,
        enabled INTEGER DEFAULT 1,
        sync_interval TEXT DEFAULT 'daily',
        last_sync INTEGER DEFAULT 0,
        next_sync INTEGER DEFAULT 0,
        auto_add_categories INTEGER DEFAULT 1,
        auto_add_channels INTEGER DEFAULT 1,
        FOREIGN KEY (provider_id) REFERENCES providers(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        sync_time INTEGER NOT NULL,
        status TEXT NOT NULL,
        channels_added INTEGER DEFAULT 0,
        channels_updated INTEGER DEFAULT 0,
        categories_added INTEGER DEFAULT 0,
        error_message TEXT,
        FOREIGN KEY (provider_id) REFERENCES providers(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS category_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        provider_category_id INTEGER NOT NULL,
        provider_category_name TEXT NOT NULL,
        user_category_id INTEGER,
        auto_created INTEGER DEFAULT 0,
        UNIQUE(provider_id, user_id, provider_category_id),
        FOREIGN KEY (provider_id) REFERENCES providers(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (user_category_id) REFERENCES user_categories(id)
      );

      CREATE TABLE IF NOT EXISTS epg_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        last_update INTEGER DEFAULT 0,
        next_update INTEGER DEFAULT 0,
        update_interval INTEGER DEFAULT 86400,
        source_type TEXT DEFAULT 'custom',
        is_updating INTEGER DEFAULT 0,
        UNIQUE(url)
      );

      CREATE TABLE IF NOT EXISTS epg_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epg_source_id INTEGER,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        programme_data TEXT,
        last_update INTEGER DEFAULT 0,
        FOREIGN KEY (epg_source_id) REFERENCES epg_sources(id)
      );

      CREATE TABLE IF NOT EXISTS epg_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_channel_id INTEGER NOT NULL,
        epg_channel_id TEXT NOT NULL,
        mapping_type TEXT DEFAULT 'manual',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(user_channel_id),
        FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
      );
    `);

    // Migration: Add user_id to existing providers (if any exist without user_id)
    try {
      const providersWithoutUser = db.prepare('SELECT COUNT(*) as count FROM providers WHERE user_id IS NULL').get();
      if (providersWithoutUser && providersWithoutUser.count > 0) {
        console.log(`⚠️  Found ${providersWithoutUser.count} providers without user_id, assigning to first admin user...`);
        const firstAdmin = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
        if (firstAdmin) {
          db.prepare('UPDATE providers SET user_id = ? WHERE user_id IS NULL').run(firstAdmin.id);
          console.log(`✅ Migrated ${providersWithoutUser.count} providers to admin user ${firstAdmin.id}`);
        }
      }
    } catch (e) {
      // Column might not exist yet, ignore
    }

    // Migration: is_adult column
    try {
        const tableInfo = db.pragma('table_info(user_categories)');
        const hasIsAdult = tableInfo.some(col => col.name === 'is_adult');
        if (!hasIsAdult) {
            db.exec('ALTER TABLE user_categories ADD COLUMN is_adult INTEGER DEFAULT 0');
            console.log('✅ DB Migration: is_adult column added');
        }
    } catch (e) {
        console.error('Migration error:', e);
    }

    console.log("✅ Database OK");
  } catch (e) {
    console.error("❌ DB Error:", e.message);
    process.exit(1);
  }
}

export default db;
