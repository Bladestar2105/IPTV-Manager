import { encrypt, decrypt } from '../utils/crypto.js';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS } from '../config/constants.js';

export function migrateProvidersSchema(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('user_id')) {
      db.exec('ALTER TABLE providers ADD COLUMN user_id INTEGER');
      console.log('✅ DB Migration: user_id column added to providers');
    }

    if (!columns.includes('epg_update_interval')) {
      db.exec('ALTER TABLE providers ADD COLUMN epg_update_interval INTEGER DEFAULT 86400');
      console.log('✅ DB Migration: epg_update_interval column added to providers');
    }

    if (!columns.includes('epg_enabled')) {
      db.exec('ALTER TABLE providers ADD COLUMN epg_enabled INTEGER DEFAULT 1');
      console.log('✅ DB Migration: epg_enabled column added to providers');
    }
  } catch (e) {
    console.error('Schema migration error:', e);
  }
}

export function migrateChannelsSchema(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('original_sort_order')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN original_sort_order INTEGER DEFAULT 0');
      console.log('✅ DB Migration: original_sort_order column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Schema migration error:', e);
  }
}

export function migrateChannelsSchemaExtended(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('tv_archive')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN tv_archive INTEGER DEFAULT 0');
      console.log('✅ DB Migration: tv_archive column added to provider_channels');
    }

    if (!columns.includes('tv_archive_duration')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN tv_archive_duration INTEGER DEFAULT 0');
      console.log('✅ DB Migration: tv_archive_duration column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Extended Schema migration error:', e);
  }
}

export function migrateCategoriesSchema(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(category_mappings)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('category_type')) {
       console.log('🔄 Migrating category_mappings table schema...');

       db.transaction(() => {
           // Rename old table
           db.prepare("ALTER TABLE category_mappings RENAME TO category_mappings_old").run();

           // Create new table with new constraint and column
           db.prepare(`
            CREATE TABLE category_mappings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              provider_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              provider_category_id INTEGER NOT NULL,
              provider_category_name TEXT NOT NULL,
              user_category_id INTEGER,
              auto_created INTEGER DEFAULT 0,
              category_type TEXT DEFAULT 'live',
              UNIQUE(provider_id, user_id, provider_category_id, category_type),
              FOREIGN KEY (provider_id) REFERENCES providers(id),
              FOREIGN KEY (user_id) REFERENCES users(id),
              FOREIGN KEY (user_category_id) REFERENCES user_categories(id)
            )
           `).run();

           // Copy data
           db.prepare(`
             INSERT INTO category_mappings (id, provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
             SELECT id, provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, 'live'
             FROM category_mappings_old
           `).run();

           // Drop old table
           db.prepare("DROP TABLE category_mappings_old").run();
       })();

       console.log('✅ category_mappings table migrated');
    }
  } catch (e) {
    console.error('Category Schema migration error:', e);
  }
}

export function migrateChannelsSchemaV2(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('metadata')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN metadata TEXT');
      console.log('✅ DB Migration: metadata column added to provider_channels');
    }

    if (!columns.includes('mime_type')) {
      db.exec('ALTER TABLE provider_channels ADD COLUMN mime_type TEXT');
      console.log('✅ DB Migration: mime_type column added to provider_channels');
    }
  } catch (e) {
    console.error('Channel Schema V2 migration error:', e);
  }
}

export function migrateChannelsSchemaV3(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(provider_channels)").all();
    const columns = tableInfo.map(c => c.name);

    const newColumns = [
      { name: 'rating', type: 'TEXT' },
      { name: 'rating_5based', type: 'REAL DEFAULT 0' },
      { name: 'added', type: 'TEXT' },
      { name: 'plot', type: 'TEXT' },
      { name: 'cast', type: 'TEXT' },
      { name: 'director', type: 'TEXT' },
      { name: 'genre', type: 'TEXT' },
      { name: 'releaseDate', type: 'TEXT' },
      { name: 'youtube_trailer', type: 'TEXT' },
      { name: 'episode_run_time', type: 'TEXT' }
    ];

    let migrationNeeded = false;
    for (const col of newColumns) {
      if (!columns.includes(col.name)) {
        db.exec(`ALTER TABLE provider_channels ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ DB Migration: ${col.name} column added to provider_channels`);
        migrationNeeded = true;
      }
    }

    if (migrationNeeded) {
        console.log('🔄 Backfilling provider_channels metadata...');
        const rows = db.prepare('SELECT id, metadata FROM provider_channels WHERE metadata IS NOT NULL').all();

        const updateStmt = db.prepare(`
            UPDATE provider_channels
            SET rating = ?, rating_5based = ?, added = ?, plot = ?, "cast" = ?, director = ?, genre = ?, releaseDate = ?, youtube_trailer = ?, episode_run_time = ?
            WHERE id = ?
        `);

        const updateTransaction = db.transaction((rowsToUpdate) => {
            let updated = 0;
            for (const row of rowsToUpdate) {
                try {
                    const meta = JSON.parse(row.metadata);
                    updateStmt.run(
                        meta.rating || '',
                        meta.rating_5based || 0,
                        meta.added || '',
                        meta.plot || '',
                        meta.cast || '',
                        meta.director || '',
                        meta.genre || '',
                        meta.releaseDate || '',
                        meta.youtube_trailer || '',
                        meta.episode_run_time || '',
                        row.id
                    );
                    updated++;
                } catch (e) {
                    // Ignore parsing errors
                }
            }
            console.log(`✅ Backfilled ${updated} channels`);
        });

        updateTransaction(rows);
    }

  } catch (e) {
    console.error('Channel Schema V3 migration error:', e);
  }
}

export function migrateUserCategoriesType(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(user_categories)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('type')) {
      db.exec("ALTER TABLE user_categories ADD COLUMN type TEXT DEFAULT 'live'");
      console.log('✅ DB Migration: type column added to user_categories');

      // Backfill type from mappings
      const stmt = db.prepare(`
        UPDATE user_categories
        SET type = (
          SELECT category_type
          FROM category_mappings
          WHERE category_mappings.user_category_id = user_categories.id
          LIMIT 1
        )
        WHERE EXISTS (
          SELECT 1
          FROM category_mappings
          WHERE category_mappings.user_category_id = user_categories.id
        )
      `);
      const info = stmt.run();
      console.log(`✅ DB Migration: Backfilled type for ${info.changes} user categories`);
    }
  } catch (e) {
    console.error('User Categories Type migration error:', e);
  }
}

export function migrateOtpSchema(db) {
  try {
    const adminTable = db.prepare("PRAGMA table_info(admin_users)").all();
    const adminCols = adminTable.map(c => c.name);

    if (!adminCols.includes('otp_secret')) {
      db.exec('ALTER TABLE admin_users ADD COLUMN otp_secret TEXT');
      db.exec('ALTER TABLE admin_users ADD COLUMN otp_enabled INTEGER DEFAULT 0');
      console.log('✅ DB Migration: OTP columns added to admin_users');
    }

    const userTable = db.prepare("PRAGMA table_info(users)").all();
    const userCols = userTable.map(c => c.name);

    if (!userCols.includes('otp_secret')) {
      db.exec('ALTER TABLE users ADD COLUMN otp_secret TEXT');
      db.exec('ALTER TABLE users ADD COLUMN otp_enabled INTEGER DEFAULT 0');
      console.log('✅ DB Migration: OTP columns added to users');
    }
  } catch (e) {
    console.error('OTP Schema migration error:', e);
  }
}

export function migrateWebUiAccess(db) {
  try {
    const userTable = db.prepare("PRAGMA table_info(users)").all();
    const userCols = userTable.map(c => c.name);

    if (!userCols.includes('webui_access')) {
      db.exec('ALTER TABLE users ADD COLUMN webui_access INTEGER DEFAULT 1');
      console.log('✅ DB Migration: webui_access column added to users');
    }
  } catch (e) {
    console.error('WebUI Access Schema migration error:', e);
  }
}

export function migrateProviderPasswords(db) {
  try {
    const providers = db.prepare('SELECT * FROM providers').all();
    let migrated = 0;
    for (const p of providers) {
      if (!p.password) continue;
      // Check if already encrypted using regex (hex:hex)
      // Supports both Legacy CBC (32 char IV) and GCM (24 char IV)
      if (/^([0-9a-f]{24}|[0-9a-f]{32}):[0-9a-f]+(:[0-9a-f]+)?$/i.test(p.password)) continue;

      // Encrypt
      const enc = encrypt(p.password);
      db.prepare('UPDATE providers SET password = ? WHERE id = ?').run(enc, p.id);
      migrated++;
    }
    if (migrated > 0) console.log(`🔐 Encrypted passwords for ${migrated} providers`);
  } catch (e) {
    console.error('Migration error:', e);
  }
}

export function migrateOptimizeDatabase(db) {
  try {
    const isOptimized = db.prepare("SELECT value FROM settings WHERE key = 'db_optimized_v1'").get();

    if (!isOptimized) {
       console.log('🧹 Optimizing database (removing duplicates)... this may take a while.');

       // 1. Drop epg_cache table
       db.exec('DROP TABLE IF EXISTS epg_cache');
       console.log('✅ Dropped epg_cache table');

       // 2. Clean metadata in provider_channels
       const rows = db.prepare('SELECT id, metadata FROM provider_channels WHERE metadata IS NOT NULL').all();
       const updateStmt = db.prepare('UPDATE provider_channels SET metadata = ? WHERE id = ?');

       let updatedCount = 0;

       db.transaction(() => {
         for (const row of rows) {
            try {
               let meta = JSON.parse(row.metadata);
               let changed = false;

               const fieldsToRemove = ['plot', 'cast', 'director', 'genre', 'rating', 'rating_5based', 'added', 'releaseDate', 'youtube_trailer', 'episode_run_time'];

               for (const field of fieldsToRemove) {
                 if (meta[field] !== undefined) {
                   delete meta[field];
                   changed = true;
                 }
               }

               if (changed) {
                 updateStmt.run(JSON.stringify(meta), row.id);
                 updatedCount++;
               }
            } catch(e) { /* ignore parse errors */ }
         }
       })();

       console.log(`✅ Cleaned metadata for ${updatedCount} channels`);

       // 3. VACUUM
       console.log('🧹 Running VACUUM to reclaim space...');
       db.exec('VACUUM');
       console.log('✅ Database optimized');

       // 4. Mark as done
       db.prepare("INSERT INTO settings (key, value) VALUES ('db_optimized_v1', 'true')").run();
    }
  } catch (e) {
    console.error('Optimization migration error:', e);
  }
}

export function checkIsAdultColumn(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(user_categories)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('is_adult')) {
      db.exec('ALTER TABLE user_categories ADD COLUMN is_adult INTEGER DEFAULT 0');
      console.log('✅ DB Migration: is_adult column added');
    }
  } catch (e) {
    console.error('Migration error:', e);
  }
}

export function migrateIndexes(db) {
  try {
    // Index on user_categories (user_id, sort_order)
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_categories_user_sort ON user_categories(user_id, sort_order)');

    // Index on user_channels (user_category_id, sort_order)
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_channels_cat_sort ON user_channels(user_category_id, sort_order)');

    // Index on user_channels (provider_channel_id) for joins
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_channels_prov ON user_channels(provider_channel_id)');

    // Only log if we suspect something changed or strictly once?
    // Since IF NOT EXISTS is silent, we can just say verified.
    // However, to avoid spamming logs on every restart, we might want to check existence, but it's fast enough.
  } catch (e) {
    console.error('Index migration error:', e);
  }
}

export function migrateOtpSecrets(db) {
  try {
    const users = db.prepare('SELECT id, otp_secret FROM users WHERE otp_secret IS NOT NULL').all();
    let migratedUsers = 0;
    for (const u of users) {
      if (!u.otp_secret) continue;
      // If NOT encrypted (doesn't match hex:hex)
      if (!/^([0-9a-f]{24}|[0-9a-f]{32}):[0-9a-f]+(:[0-9a-f]+)?$/i.test(u.otp_secret)) {
        const encrypted = encrypt(u.otp_secret);
        db.prepare('UPDATE users SET otp_secret = ? WHERE id = ?').run(encrypted, u.id);
        migratedUsers++;
      }
    }

    const admins = db.prepare('SELECT id, otp_secret FROM admin_users WHERE otp_secret IS NOT NULL').all();
    let migratedAdmins = 0;
    for (const a of admins) {
      if (!a.otp_secret) continue;
      if (!/^([0-9a-f]{24}|[0-9a-f]{32}):[0-9a-f]+(:[0-9a-f]+)?$/i.test(a.otp_secret)) {
        const encrypted = encrypt(a.otp_secret);
        db.prepare('UPDATE admin_users SET otp_secret = ? WHERE id = ?').run(encrypted, a.id);
        migratedAdmins++;
      }
    }

    if (migratedUsers > 0 || migratedAdmins > 0) {
        console.log(`🔐 Encrypted OTP secrets for ${migratedUsers} users and ${migratedAdmins} admins`);
    }
  } catch (e) {
    console.error('OTP Secret migration error:', e);
  }
}

export function migrateUserPasswords(db) {
  try {
    const users = db.prepare('SELECT id, password FROM users').all();
    let migratedCount = 0;

    for (const user of users) {
      if (!user.password) continue;

      // Check if already bcrypt (starts with $2b$)
      if (user.password.startsWith('$2b$')) continue;

      // Try to decrypt (assuming it was encrypted with reversible encryption)
      const decrypted = decrypt(user.password);

      if (decrypted) {
         const hashed = bcrypt.hashSync(decrypted, BCRYPT_ROUNDS);
         db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
         migratedCount++;
      }
    }

    if (migratedCount > 0) {
      console.log(`🔐 Migrated ${migratedCount} user passwords to bcrypt hashes`);
    }
  } catch (e) {
    console.error('User Password migration error:', e);
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
