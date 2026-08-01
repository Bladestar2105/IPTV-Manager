export function migrateUserTokenVersion(db) {
  try {
    // Add token_version to users
    let tableInfo = db.pragma('table_info(users)');
    let hasTokenVersion = tableInfo.some(c => c.name === 'token_version');
    if (!hasTokenVersion) {
      db.prepare('ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0').run();
      console.log('✅ Added token_version column to users table');
    }

    // Add token_version to admin_users
    tableInfo = db.pragma('table_info(admin_users)');
    hasTokenVersion = tableInfo.some(c => c.name === 'token_version');
    if (!hasTokenVersion) {
      db.prepare('ALTER TABLE admin_users ADD COLUMN token_version INTEGER DEFAULT 0').run();
      console.log('✅ Added token_version column to admin_users table');
    }
  } catch (e) {
    console.error('Error migrating user token version schema:', e);
  }
}

export function migrateProviderExpiry(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('expiry_date')) {
      db.exec('ALTER TABLE providers ADD COLUMN expiry_date INTEGER');
      console.log('✅ DB Migration: expiry_date column added to providers');
    }
  } catch (e) {
    console.error('Provider Expiry migration error:', e);
  }
}

export function migrateHdhrColumns(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('hdhr_enabled')) {
      db.exec('ALTER TABLE users ADD COLUMN hdhr_enabled INTEGER DEFAULT 0');
      console.log('✅ DB Migration: hdhr_enabled column added to users');
    }

    if (!columns.includes('hdhr_token')) {
      db.exec('ALTER TABLE users ADD COLUMN hdhr_token TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hdhr_token ON users(hdhr_token)');
      console.log('✅ DB Migration: hdhr_token column added to users');
    }
  } catch (e) {
    console.error('HDHR Columns migration error:', e);
  }
}

export function migrateTemporaryTokensSchema(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(temporary_tokens)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('session_id')) {
      db.exec('ALTER TABLE temporary_tokens ADD COLUMN session_id TEXT');
      console.log('✅ DB Migration: session_id column added to temporary_tokens');
    }
  } catch (e) {
    console.error('Temporary Tokens Schema migration error:', e);
  }
}

export function migrateSharedLinksSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_links (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT,
        channels TEXT NOT NULL,
        start_time INTEGER,
        end_time INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    // Check if index exists? PK implies index.
  } catch (e) {
    console.error('Shared Links Schema migration error:', e);
  }
}

export function migrateProviderBackupUrls(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('backup_urls')) {
      db.exec('ALTER TABLE providers ADD COLUMN backup_urls TEXT');
      console.log('✅ DB Migration: backup_urls column added to providers');
    }
  } catch (e) {
    console.error('Provider Backup URLs migration error:', e);
  }
}

export function migrateSharedLinkSlug(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(shared_links)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('slug')) {
      db.exec('ALTER TABLE shared_links ADD COLUMN slug TEXT');
      console.log('✅ DB Migration: slug column added to shared_links');
    }

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_links_slug ON shared_links(slug)');
  } catch (e) {
    console.error('Shared Link Slug migration error:', e);
  }
}

export function migrateProviderUserAgent(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('user_agent')) {
      db.exec('ALTER TABLE providers ADD COLUMN user_agent TEXT');
      console.log('✅ DB Migration: user_agent column added to providers');
    }
  } catch (e) {
    console.error('Provider User-Agent migration error:', e);
  }
}

export function migrateAdminForcePasswordChange(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(admin_users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('force_password_change')) {
      db.exec('ALTER TABLE admin_users ADD COLUMN force_password_change INTEGER DEFAULT 0');
      console.log('✅ DB Migration: force_password_change column added to admin_users');
    }
  } catch (e) {
    console.error('Admin Force Password Change migration error:', e);
  }
}

export function migrateUserMaxConnections(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('max_connections')) {
      db.exec('ALTER TABLE users ADD COLUMN max_connections INTEGER DEFAULT 0');
      console.log('✅ DB Migration: max_connections column added to users');
    }
  } catch (e) {
    console.error('User Max Connections migration error:', e);
  }
}

export function migrateProviderMaxConnections(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('max_connections')) {
      db.exec('ALTER TABLE providers ADD COLUMN max_connections INTEGER DEFAULT 0');
      console.log('✅ DB Migration: max_connections column added to providers');
    }
  } catch (e) {
    console.error('Provider Max Connections migration error:', e);
  }
}

export function migrateCurrentStreamsProviderId(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(current_streams)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('provider_id')) {
      // Since current_streams is often cleared/recreated, we can just drop/recreate OR alter.
      // But db.js does "CREATE TABLE IF NOT EXISTS".
      // If we are in initDb, it might be cleared.
      // Safest is ALTER.
      db.exec('ALTER TABLE current_streams ADD COLUMN provider_id INTEGER');
      console.log('✅ DB Migration: provider_id column added to current_streams');
    }
  } catch (e) {
    console.error('Current Streams Provider ID migration error:', e);
  }
}

export function migrateCurrentStreamsLastActivity(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(current_streams)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('last_activity')) {
      db.exec('ALTER TABLE current_streams ADD COLUMN last_activity INTEGER');
      db.exec('UPDATE current_streams SET last_activity = COALESCE(start_time, CAST(strftime(\'%s\', \'now\') AS INTEGER) * 1000) WHERE last_activity IS NULL');
      console.log('✅ DB Migration: last_activity column added to current_streams');
    }
  } catch (e) {
    console.error('Current Streams last_activity migration error:', e);
  }
}

export function migrateProviderLastEpgUpdate(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('last_epg_update')) {
      db.exec('ALTER TABLE providers ADD COLUMN last_epg_update INTEGER DEFAULT 0');
      console.log('✅ DB Migration: last_epg_update column added to providers');
    }
  } catch (e) {
    console.error('Provider Last EPG Update migration error:', e);
  }
}

export function migrateUserPlainPassword(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('plain_password')) {
      db.exec('ALTER TABLE users ADD COLUMN plain_password TEXT');
      console.log('✅ DB Migration: plain_password column added to users');
    }
  } catch (e) {
    console.error('User plain password migration error:', e);
  }
}

export function migrateUserBackupsTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        category_count INTEGER DEFAULT 0,
        channel_count INTEGER DEFAULT 0,
        data TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
  } catch (err) {
    console.error('Migration error (user_backups):', err.message);
  }
}

export function migrateUserExpiryDate(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('expiry_date')) {
      db.exec('ALTER TABLE users ADD COLUMN expiry_date INTEGER');
      console.log('✅ DB Migration: expiry_date column added to users');
    }
  } catch (e) {
    console.error('User Expiry Date migration error:', e);
  }
}

export function migrateUserAllowedCountries(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('allowed_countries')) {
      db.exec('ALTER TABLE users ADD COLUMN allowed_countries TEXT');
      console.log('✅ DB Migration: allowed_countries column added to users');
    }
  } catch (e) {
    console.error('User Allowed Countries migration error:', e);
  }
}

export function migrateUserChannelsCustomName(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(user_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('custom_name')) {
      db.exec("ALTER TABLE user_channels ADD COLUMN custom_name TEXT DEFAULT ''");
      console.log('✅ DB Migration: custom_name column added to user_channels');
    }
  } catch (e) {
    console.error('User Channels Custom Name migration error:', e);
  }
}

export function migrateUserChannelsIsHidden(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(user_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('is_hidden')) {
      db.exec('ALTER TABLE user_channels ADD COLUMN is_hidden INTEGER DEFAULT 0');
      console.log('✅ DB Migration: is_hidden column added to user_channels');
    }
  } catch (e) {
    console.error('User Channels is_hidden migration error:', e);
  }
}
