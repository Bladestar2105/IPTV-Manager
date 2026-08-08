import { encrypt, decrypt } from '../utils/crypto.js';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS } from '../config/constants.js';
import { clearSettingsCache } from '../utils/helpers.js';

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

export function migrateUserProviderAccess(db) {
  try {
    const userTable = db.prepare("PRAGMA table_info(users)").all();
    const userCols = userTable.map(c => c.name);

    if (!userCols.includes('provider_access')) {
      db.exec('ALTER TABLE users ADD COLUMN provider_access INTEGER DEFAULT 0');
      console.log('✅ DB Migration: provider_access column added to users');
    }
  } catch (e) {
    console.error('Provider Access Schema migration error:', e);
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
            } catch { /* ignore parse errors */ }
         }
       })();

       console.log(`✅ Cleaned metadata for ${updatedCount} channels`);

       // 3. VACUUM
       console.log('🧹 Running VACUUM to reclaim space...');
       db.exec('VACUUM');
       console.log('✅ Database optimized');

       // 4. Mark as done
       db.prepare("INSERT INTO settings (key, value) VALUES ('db_optimized_v1', 'true')").run();
       clearSettingsCache();
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


    // Optimization Indices
    db.exec('CREATE INDEX IF NOT EXISTS idx_stream_stats_channel ON stream_stats(channel_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sync_logs_prov ON sync_logs(provider_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_current_streams_prov ON current_streams(provider_id)');

    // ⚡ Bolt: Add composite indexes for rapid filtering and sorting in provider endpoints without creating Temp B-trees
    db.exec('CREATE INDEX IF NOT EXISTS idx_pc_prov_type_sort_name ON provider_channels(provider_id, stream_type, original_sort_order, name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pc_prov_sort_name ON provider_channels(provider_id, original_sort_order, name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pc_prov_type_cat_sort_name ON provider_channels(provider_id, stream_type, original_category_id, original_sort_order, name)');

    // ⚡ Bolt: Add composite index for rapid rate-limiting queries to prevent full table scans during brute-force DoS attacks
    db.exec('CREATE INDEX IF NOT EXISTS idx_security_logs_ip_time ON security_logs(ip, timestamp)');

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
    const updateUserStmt = db.prepare('UPDATE users SET otp_secret = ? WHERE id = ?');

    db.transaction(() => {
      for (const u of users) {
        if (!u.otp_secret) continue;
        // If NOT encrypted (doesn't match hex:hex)
        if (!/^([0-9a-f]{24}|[0-9a-f]{32}):[0-9a-f]+(:[0-9a-f]+)?$/i.test(u.otp_secret)) {
          const encrypted = encrypt(u.otp_secret);
          updateUserStmt.run(encrypted, u.id);
          migratedUsers++;
        }
      }
    })();

    const admins = db.prepare('SELECT id, otp_secret FROM admin_users WHERE otp_secret IS NOT NULL').all();
    let migratedAdmins = 0;
    const updateAdminStmt = db.prepare('UPDATE admin_users SET otp_secret = ? WHERE id = ?');

    db.transaction(() => {
      for (const a of admins) {
        if (!a.otp_secret) continue;
        if (!/^([0-9a-f]{24}|[0-9a-f]{32}):[0-9a-f]+(:[0-9a-f]+)?$/i.test(a.otp_secret)) {
          const encrypted = encrypt(a.otp_secret);
          updateAdminStmt.run(encrypted, a.id);
          migratedAdmins++;
        }
      }
    })();

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
