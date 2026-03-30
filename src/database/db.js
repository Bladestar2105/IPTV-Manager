import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DATA_DIR } from '../config/constants.js';
import * as migrations from './migrations.js';

// Ensure Data Directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'db.sqlite'));
// Enable foreign keys
db.pragma('foreign_keys = ON');
// Performance tuning
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

export function initDb(isPrimary) {
    // Attach EPG database
    try {
        db.exec(`ATTACH DATABASE '${path.join(DATA_DIR, 'epg.sqlite')}' AS epg_db;`);
    } catch (e) {
        if (!e.message.includes('database epg_db is already in use')) {
            console.error('Failed to attach EPG database:', e);
        }
    }

    if (isPrimary) {
        try {
            db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      epg_url TEXT,
      user_id INTEGER,
      epg_update_interval INTEGER DEFAULT 86400,
      epg_enabled INTEGER DEFAULT 1,
      max_connections INTEGER DEFAULT 0,
      last_epg_update INTEGER DEFAULT 0
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
      original_sort_order INTEGER DEFAULT 0,
      tv_archive INTEGER DEFAULT 0,
      tv_archive_duration INTEGER DEFAULT 0,
      UNIQUE(provider_id, remote_stream_id)
    );

    CREATE TABLE IF NOT EXISTS stream_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      views INTEGER DEFAULT 0,
      last_viewed INTEGER DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES provider_channels(id)
    );

    CREATE TABLE IF NOT EXISTS current_streams (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      username TEXT,
      channel_name TEXT,
      start_time INTEGER,
      ip TEXT,
      worker_pid INTEGER,
      provider_id INTEGER
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
      plain_password TEXT,
      is_active INTEGER DEFAULT 1,
      max_connections INTEGER DEFAULT 0,
      expiry_date INTEGER,
      allowed_countries TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS temporary_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_adult INTEGER DEFAULT 0,
      type TEXT DEFAULT 'live'
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0,
      custom_name TEXT DEFAULT '',
      is_hidden INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      category_count INTEGER DEFAULT 0,
      channel_count INTEGER DEFAULT 0,
      data TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
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
      update_interval INTEGER DEFAULT 86400,
      source_type TEXT DEFAULT 'custom',
      is_updating INTEGER DEFAULT 0,
      UNIQUE(url)
    );

    CREATE TABLE IF NOT EXISTS epg_channel_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_channel_id INTEGER NOT NULL UNIQUE,
      epg_channel_id TEXT NOT NULL,
      FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id)
    );

    -- Security Tables
    CREATE TABLE IF NOT EXISTS security_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocked_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL UNIQUE,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS whitelisted_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Client Logs
    CREATE TABLE IF NOT EXISTS client_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'error',
      message TEXT,
      timestamp INTEGER NOT NULL,
      user_agent TEXT,
      stack TEXT
    );
  `);

            db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pc_prov_type ON provider_channels(provider_id, stream_type);
    CREATE INDEX IF NOT EXISTS idx_pc_name ON provider_channels(name);
    CREATE INDEX IF NOT EXISTS idx_cs_user_ip ON current_streams(user_id, ip);
    CREATE INDEX IF NOT EXISTS idx_user_channels_cat_sort ON user_channels(user_category_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_user_channels_prov ON user_channels(provider_channel_id);

    -- ⚡ Bolt: Add composite index for rapid sorting of channels within categories while skipping hidden channels
    CREATE INDEX IF NOT EXISTS idx_user_channels_cat_hidden_sort ON user_channels(user_category_id, is_hidden, sort_order);
    CREATE INDEX IF NOT EXISTS idx_user_categories_user_sort ON user_categories(user_id, sort_order);

    -- ⚡ Bolt: Add composite indexes for rapid filtering and sorting in provider endpoints without creating Temp B-trees
    CREATE INDEX IF NOT EXISTS idx_pc_prov_type_sort_name ON provider_channels(provider_id, stream_type, original_sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_pc_prov_sort_name ON provider_channels(provider_id, original_sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_pc_prov_type_cat_sort_name ON provider_channels(provider_id, stream_type, original_category_id, original_sort_order, name);

    -- ⚡ Bolt: Add composite index for rapid rate-limiting queries to prevent full table scans during brute-force DoS attacks
    CREATE INDEX IF NOT EXISTS idx_security_logs_ip_time ON security_logs(ip, timestamp);
  `);

            console.log("✅ Database OK");

            // Migrate providers schema
            migrations.migrateProvidersSchema(db);
            migrations.migrateChannelsSchema(db);
            migrations.migrateChannelsSchemaExtended(db);
            migrations.migrateCategoriesSchema(db);
            migrations.migrateChannelsSchemaV2(db);
            migrations.migrateChannelsSchemaV3(db);
            migrations.migrateUserCategoriesType(db);
            migrations.migrateOtpSchema(db);
            migrations.migrateWebUiAccess(db);
            migrations.migrateProviderPasswords(db);
            migrations.migrateOptimizeDatabase(db);
            migrations.checkIsAdultColumn(db);
            migrations.migrateIndexes(db);
            migrations.migrateOtpSecrets(db);
            migrations.migrateUserPasswords(db);
            migrations.migrateProviderExpiry(db);
            migrations.migrateHdhrColumns(db);
            migrations.migrateTemporaryTokensSchema(db);
            migrations.migrateSharedLinksSchema(db);
            migrations.migrateProviderBackupUrls(db);
            migrations.migrateSharedLinkSlug(db);
            migrations.migrateProviderUserAgent(db);
            migrations.migrateAdminForcePasswordChange(db);
            migrations.migrateUserMaxConnections(db);
            migrations.migrateProviderMaxConnections(db);
            migrations.migrateCurrentStreamsProviderId(db);
            migrations.migrateProviderLastEpgUpdate(db);
            migrations.migrateUserPlainPassword(db);
            migrations.migrateUserBackupsTable(db);
            migrations.migrateUserExpiryDate(db);
            migrations.migrateUserTokenVersion(db);
            migrations.migrateUserAllowedCountries(db);
            migrations.migrateUserChannelsCustomName(db);
            migrations.migrateUserChannelsIsHidden(db);
            migrations.migrateUserNotes(db);
            if (typeof migrations.migrateProviderUseMappedEpgIcon === 'function') {
                migrations.migrateProviderUseMappedEpgIcon(db);
            }

            // Clear ephemeral streams
            db.exec('DELETE FROM current_streams');

        } catch (e) {
            console.error("❌ DB Error:", e.message);
            process.exit(1);
        }
    }
}

export default db;
