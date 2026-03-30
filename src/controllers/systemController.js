import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import db from '../database/db.js';
import streamManager from '../services/streamManager.js';
import { encryptWithPassword, decryptWithPassword, decrypt, encrypt } from '../utils/crypto.js';
import { calculateNextSync } from '../services/syncService.js';
import { clearSettingsCache } from '../utils/helpers.js';
import { isIP } from 'net';
import { isSafeUrl, cleanIp } from '../utils/helpers.js';
import si from 'systeminformation';
import { spawn } from 'child_process';
import path from 'path';
import geoip from 'geoip-lite';

let initialNetStats = null;
si.networkStats().then(stats => {
  const primaryNet = stats.find(net => net.operstate === 'up') || stats[0] || {};
  initialNetStats = {
    rx_bytes: primaryNet.rx_bytes || 0,
    tx_bytes: primaryNet.tx_bytes || 0
  };
}).catch(() => {
  initialNetStats = { rx_bytes: 0, tx_bytes: 0 };
});

export const getSettings = (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const updateSettings = (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});
    const settings = req.body;
    const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        insert.run(key, String(value));
      }
    })();
    clearSettingsCache();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createClientLog = (req, res) => {
  try {
    const { level, message, stack, user_agent } = req.body;

    // Input Validation & Sanitization
    const allowedLevels = ['info', 'warn', 'error', 'debug'];
    let safeLevel = (level || 'error').toString().toLowerCase();
    if (!allowedLevels.includes(safeLevel)) safeLevel = 'error';

    // Strip HTML tags and limit length
    const stripHtml = (str) => (str || '').toString().replace(/<[^>]*>?/gm, '');

    const safeMessage = stripHtml(message || 'Unknown').substring(0, 500);
    const safeStack = stripHtml(stack || '').substring(0, 1000);
    const safeUserAgent = stripHtml(user_agent || '').substring(0, 200);

    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO client_logs (level, message, stack, user_agent, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(safeLevel, safeMessage, safeStack, safeUserAgent, now);
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getClientLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM client_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const deleteClientLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM client_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getSecurityLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM security_logs ORDER BY timestamp DESC LIMIT ?').all(limit);

    // Augment with country code
    const logsWithGeo = logs.map(log => {
      const geo = geoip.lookup(cleanIp(log.ip));
      return { ...log, country: geo && geo.country ? geo.country : null };
    });

    res.json(logsWithGeo);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const deleteSecurityLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM security_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getBlockedIps = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const ips = db.prepare('SELECT * FROM blocked_ips ORDER BY created_at DESC').all();

    // Augment with country code for better admin check
    const ipsWithGeo = ips.map(b => {
      const geo = geoip.lookup(cleanIp(b.ip));
      return { ...b, country: geo && geo.country ? geo.country : null };
    });

    res.json(ipsWithGeo);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const blockIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { ip, reason, duration } = req.body;
    if (!ip || isIP(ip) === 0) return res.status(400).json({error: 'Valid IP required'});

    const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);
    if (whitelisted) {
      return res.status(400).json({error: 'IP is whitelisted. Remove from whitelist first.'});
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (Number(duration) || 3600);

    db.prepare(`
      INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason
    `).run(ip, reason || 'Manual Block', expiresAt);

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Manual Block: ${reason || 'No reason'}`, now);

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const unblockIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = req.params.id;
    const now = Math.floor(Date.now() / 1000);
    let ipToLog = id;

    if (id.includes('.') || id.includes(':')) {
       const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(id);
       if (info.changes > 0) {
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(id, 'ip_unblocked', 'Manual Unblock', now);
       }
    } else {
       const entry = db.prepare('SELECT ip FROM blocked_ips WHERE id = ?').get(id);
       if (entry) {
          ipToLog = entry.ip;
          db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(id);
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ipToLog, 'ip_unblocked', 'Manual Unblock', now);
       }
    }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getWhitelist = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const ips = db.prepare('SELECT * FROM whitelisted_ips ORDER BY created_at DESC').all();
    res.json(ips);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const whitelistIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { ip, description } = req.body;
    if (!ip || isIP(ip) === 0) return res.status(400).json({error: 'Valid IP required'});

    db.prepare('INSERT OR REPLACE INTO whitelisted_ips (ip, description) VALUES (?, ?)').run(ip, description || '');
    const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(ip);

    if (info.changes > 0) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_unblocked', 'Automatically unblocked due to whitelisting', now);
    }

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const removeWhitelist = (req, res) => {
  try {
     if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
     const id = req.params.id;
     if (id.includes('.') || id.includes(':')) {
        db.prepare('DELETE FROM whitelisted_ips WHERE ip = ?').run(id);
     } else {
        db.prepare('DELETE FROM whitelisted_ips WHERE id = ?').run(id);
     }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const exportData = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const user_id = req.body.user_id || req.query.user_id;
    const password = req.body.password || req.query.password;

    if (!password) {
      return res.status(400).json({error: 'Password required for encryption'});
    }

    const exportData = {
      version: 1,
      timestamp: Date.now(),
      users: [],
      providers: [],
      categories: [],
      channels: [],
      mappings: [],
      sync_configs: []
    };

    let usersToExport = [];
    if (user_id && user_id !== 'all') {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(user_id));
      if (!user) return res.status(404).json({error: 'User not found'});
      usersToExport.push(user);
    } else {
      usersToExport = db.prepare('SELECT * FROM users').all();
    }

    exportData.users = usersToExport;

    if (usersToExport.length > 0) {
       const userIds = usersToExport.map(u => u.id);
       // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
       const userPlaceholders = Array(userIds.length).fill('?').join(',');

       const providers = db.prepare(`SELECT * FROM providers WHERE user_id IN (${userPlaceholders})`).all(...userIds);

       const providerIds = [];
       for (const p of providers) {
          p.password = decrypt(p.password) || p.password;
          exportData.providers.push(p);
          providerIds.push(p.id);
       }

       if (providerIds.length > 0) {
          // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
          const provPlaceholders = Array(providerIds.length).fill('?').join(',');

          const channels = db.prepare(`SELECT * FROM provider_channels WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          for (const c of channels) exportData.channels.push(c);

          const mappings = db.prepare(`SELECT * FROM category_mappings WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          for (const m of mappings) exportData.mappings.push(m);

          const syncs = db.prepare(`SELECT * FROM sync_configs WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          for (const s of syncs) exportData.sync_configs.push(s);
       }

       const categories = db.prepare(`SELECT * FROM user_categories WHERE user_id IN (${userPlaceholders})`).all(...userIds);
       for (const c of categories) exportData.categories.push(c);

       const userChannels = db.prepare(`
         SELECT uc.*
         FROM user_channels uc
         JOIN user_categories cat ON cat.id = uc.user_category_id
         WHERE cat.user_id IN (${userPlaceholders})
       `).all(...userIds);
       for (const uc of userChannels) exportData.channels.push({...uc, type: 'user_assignment'});
    }

    const jsonStr = JSON.stringify(exportData);
    const compressed = zlib.gzipSync(jsonStr);

    const encrypted = encryptWithPassword(compressed, password);

    res.setHeader('Content-Disposition', `attachment; filename="iptv_export_${Date.now()}.bin"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(encrypted);

  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({error: e.message});
  }
};

export const updateGeoIpDatabase = (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});

    let licenseKey = req.body?.license_key;

    if (licenseKey) {
       db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('geoip_license_key', licenseKey);
       clearSettingsCache();
    } else {
       const licenseKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('geoip_license_key');
       licenseKey = licenseKeyRow ? licenseKeyRow.value : '';
    }

    if (!licenseKey) {
       return res.status(400).json({error: 'A MaxMind License Key is required to update the GeoIP database. Please add it in Settings.'});
    }

    const scriptPath = path.resolve('node_modules/geoip-lite/scripts/updatedb.js');
    const child = spawn(process.execPath, ['--max-old-space-size=4096', scriptPath, `license_key=${licenseKey}`], {
        cwd: path.resolve('node_modules/geoip-lite'),
        env: { ...process.env, LICENSE_KEY: licenseKey },
        stdio: 'inherit'
    });

    child.on('error', (err) => {
        console.error('Failed to start GeoIP update process:', err);
    });

    child.on('close', async (code) => {
        if (code === 0) {
            console.log('GeoIP database updated successfully.');
            try {
                const geoipLite = (await import('geoip-lite')).default;
                geoipLite.reloadDataSync();
                console.log('GeoIP in-memory cache reloaded successfully.');
            } catch (e) {
                console.error('Failed to reload GeoIP cache:', e);
            }
            db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
                req.ip, 'GeoIP Update', 'Database updated successfully', Math.floor(Date.now() / 1000)
            );
        } else {
            console.error(`GeoIP update process exited with code ${code}`);
            db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
                req.ip, 'GeoIP Update Failed', `Process exited with code ${code}`, Math.floor(Date.now() / 1000)
            );
        }
    });

    res.json({ success: true, message: 'GeoIP database update started in the background.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const importData = async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
  let tempPath = null;
  try {
    const { password } = req.body;
    if (!req.file || !password) {
      return res.status(400).json({error: 'File and password required'});
    }

    tempPath = req.file.path;
    const encryptedData = await fs.promises.readFile(tempPath);

    let compressed;
    try {
      compressed = decryptWithPassword(encryptedData, password);
    } catch (e) {
      return res.status(400).json({error: 'Decryption failed. Wrong password?'});
    }

    let jsonStr;
    try {
      // Security: Use maxOutputLength to prevent Zip Bomb / DoS attacks
      // Limit to 200MB of uncompressed JSON data
      jsonStr = zlib.gunzipSync(compressed, { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8');
    } catch (e) {
      return res.status(400).json({error: 'Decompression failed or file too large.'});
    }

    const importData = JSON.parse(jsonStr);

    if (!importData.version || !importData.users) {
      return res.status(400).json({error: 'Invalid export file format'});
    }

    // Security validation for URLs
    for (const p of importData.providers || []) {
        if (p.url && !(await isSafeUrl(p.url))) {
            return res.status(400).json({error: 'invalid_url', message: `Provider URL is unsafe: ${p.url}`});
        }
        if (p.epg_url && !(await isSafeUrl(p.epg_url))) {
            return res.status(400).json({error: 'invalid_url', message: `EPG URL is unsafe: ${p.epg_url}`});
        }
        if (p.backup_urls) {
            let urls = [];
            try {
                if (Array.isArray(p.backup_urls)) {
                    urls = p.backup_urls;
                } else {
                    urls = JSON.parse(p.backup_urls);
                }
            } catch (e) {
                if (typeof p.backup_urls === 'string') urls = p.backup_urls.split('\n');
            }

            if (Array.isArray(urls)) {
                for (const u of urls) {
                    const trimmed = u.trim();
                    if (trimmed && !(await isSafeUrl(trimmed))) {
                        return res.status(400).json({error: 'invalid_url', message: `Backup URL is unsafe: ${trimmed}`});
                    }
                }
            }
        }
    }

    const stats = {
      users_imported: 0,
      users_skipped: 0,
      providers: 0,
      categories: 0,
      channels: 0
    };

    db.transaction(() => {
      const userIdMap = new Map();
      const providerIdMap = new Map();
      const categoryIdMap = new Map();
      const providerChannelIdMap = new Map();

      // Pre-fetch existing users to avoid N+1 query
      const existingUsers = db.prepare('SELECT id, username FROM users').all();
      const existingUserMap = new Map(existingUsers.map(u => [u.username, u.id]));

      // ⚡ Bolt: Hoist prepared statements to prevent query recompilation inside loops
      const insertUserStmt = db.prepare(`
        INSERT INTO users (username, password, is_active, webui_access, hdhr_enabled, hdhr_token, otp_enabled, otp_secret)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const user of importData.users) {
        const existingId = existingUserMap.get(user.username);
        if (existingId) {
          console.log(`Skipping existing user: ${user.username}`);
          userIdMap.set(user.id, existingId);
          stats.users_skipped++;
          continue;
        }

        let hdhrToken = user.hdhr_token;
        const hdhrEnabled = user.hdhr_enabled ? 1 : 0;

        if (hdhrEnabled && !hdhrToken) {
           hdhrToken = crypto.randomBytes(16).toString('hex');
        }

        const webuiAccess = user.webui_access !== undefined ? (user.webui_access ? 1 : 0) : 1;
        const otpEnabled = user.otp_enabled ? 1 : 0;
        const otpSecret = user.otp_secret || null;
        const isActive = user.is_active !== undefined ? (user.is_active ? 1 : 0) : 1;

        const info = insertUserStmt.run(
          user.username,
          user.password,
          isActive,
          webuiAccess,
          hdhrEnabled,
          hdhrToken,
          otpEnabled,
          otpSecret
        );

        const newUserId = info.lastInsertRowid;
        userIdMap.set(user.id, newUserId);
        existingUserMap.set(user.username, newUserId);
        stats.users_imported++;
      }

      const insertProviderStmt = db.prepare(`
        INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, expiry_date, backup_urls, user_agent, max_connections)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of importData.providers) {
        const newUserId = userIdMap.get(p.user_id);
        if (!newUserId) continue;

        const newPassword = encrypt(p.password);

        const info = insertProviderStmt.run(
          p.name,
          p.url,
          p.username,
          newPassword,
          p.epg_url,
          newUserId,
          p.epg_update_interval,
          p.epg_enabled,
          p.expiry_date || null,
          p.backup_urls || null,
          p.user_agent || null,
          p.max_connections || 0
        );

        providerIdMap.set(p.id, info.lastInsertRowid);
        stats.providers++;
      }

      const provChannels = importData.channels.filter(c => !c.type && providerIdMap.has(c.provider_id));

      const insertProvChannel = db.prepare(`
        INSERT INTO provider_channels (
          provider_id, remote_stream_id, name, original_category_id, logo, stream_type,
          epg_channel_id, original_sort_order, tv_archive, tv_archive_duration,
          mime_type, metadata, rating, rating_5based, added, plot, "cast", director, genre, releaseDate, youtube_trailer, episode_run_time
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ch of provChannels) {
        const newProvId = providerIdMap.get(ch.provider_id);
        const info = insertProvChannel.run(
          newProvId,
          ch.remote_stream_id,
          ch.name,
          ch.original_category_id,
          ch.logo,
          ch.stream_type,
          ch.epg_channel_id,
          ch.original_sort_order,
          ch.tv_archive || 0,
          ch.tv_archive_duration || 0,
          ch.mime_type || null,
          ch.metadata || null,
          ch.rating || null,
          ch.rating_5based || 0,
          ch.added || null,
          ch.plot || null,
          ch.cast || null,
          ch.director || null,
          ch.genre || null,
          ch.releaseDate || null,
          ch.youtube_trailer || null,
          ch.episode_run_time || null
        );
        providerChannelIdMap.set(ch.id, info.lastInsertRowid);
      }

      const insertCategoryStmt = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)');

      for (const cat of importData.categories) {
        const newUserId = userIdMap.get(cat.user_id);
        if (!newUserId) continue;

        const catType = cat.type || 'live';
        const info = insertCategoryStmt.run(newUserId, cat.name, cat.is_adult, cat.sort_order, catType);
        categoryIdMap.set(cat.id, info.lastInsertRowid);
        stats.categories++;
      }

      const insertMappingStmt = db.prepare(`
        INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const m of importData.mappings) {
        const newProvId = providerIdMap.get(m.provider_id);
        const newUserId = userIdMap.get(m.user_id);
        const newUserCatId = m.user_category_id ? categoryIdMap.get(m.user_category_id) : null;

        if (newProvId && newUserId) {
           insertMappingStmt.run(newProvId, newUserId, m.provider_category_id, m.provider_category_name, newUserCatId, m.auto_created, m.category_type || 'live');
        }
      }

      const insertSyncConfigStmt = db.prepare(`
        INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, last_sync, next_sync, auto_add_categories, auto_add_channels)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const s of importData.sync_configs) {
        const newProvId = providerIdMap.get(s.provider_id);
        const newUserId = userIdMap.get(s.user_id);

        if (newProvId && newUserId) {
          insertSyncConfigStmt.run(newProvId, newUserId, s.enabled, s.sync_interval, 0, 0, s.auto_add_categories, s.auto_add_channels);
        }
      }

      const userAssignments = importData.channels.filter(c => c.type === 'user_assignment');
      const insertUserChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order, custom_name) VALUES (?, ?, ?, ?)');

      for (const ua of userAssignments) {
        const newUserCatId = categoryIdMap.get(ua.user_category_id);
        const newProvChannelId = providerChannelIdMap.get(ua.provider_channel_id);

        if (newUserCatId && newProvChannelId) {
          insertUserChannel.run(newUserCatId, newProvChannelId, ua.sort_order, ua.custom_name || '');
          stats.channels++;
        }
      }

    })();

    res.json({success: true, stats});

  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({error: e.message});
  } finally {
    if (tempPath) {
      try { await fs.promises.unlink(tempPath); } catch(e) {}
    }
  }
};

export const getSyncConfigs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const configs = db.prepare(`
      SELECT sc.*, p.name as provider_name, u.username
      FROM sync_configs sc
      JOIN providers p ON p.id = sc.provider_id
      JOIN users u ON u.id = sc.user_id
      ORDER BY sc.id
    `).all();
    res.json(configs);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getSyncConfig = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?')
      .get(Number(req.params.providerId), Number(req.params.userId));
    res.json(config || null);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const createSyncConfig = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { provider_id, user_id, enabled, sync_interval, auto_add_categories, auto_add_channels } = req.body;

    if (!provider_id || !user_id) {
      return res.status(400).json({error: 'provider_id and user_id required'});
    }

    const nextSync = calculateNextSync(sync_interval || 'daily');

    const info = db.prepare(`
      INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, next_sync, auto_add_categories, auto_add_channels)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      provider_id,
      user_id,
      enabled ? 1 : 0,
      sync_interval || 'daily',
      nextSync,
      auto_add_categories ? 1 : 0,
      auto_add_channels ? 1 : 0
    );

    res.json({id: info.lastInsertRowid});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const updateSyncConfig = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { enabled, sync_interval, auto_add_categories, auto_add_channels } = req.body;

    const config = db.prepare('SELECT * FROM sync_configs WHERE id = ?').get(id);
    if (!config) return res.status(404).json({error: 'not found'});

    const nextSync = calculateNextSync(sync_interval || config.sync_interval);

    db.prepare(`
      UPDATE sync_configs
      SET enabled = ?, sync_interval = ?, next_sync = ?, auto_add_categories = ?, auto_add_channels = ?
      WHERE id = ?
    `).run(
      enabled !== undefined ? (enabled ? 1 : 0) : config.enabled,
      sync_interval || config.sync_interval,
      nextSync,
      auto_add_categories !== undefined ? (auto_add_categories ? 1 : 0) : config.auto_add_categories,
      auto_add_channels !== undefined ? (auto_add_channels ? 1 : 0) : config.auto_add_channels,
      id
    );

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteSyncConfig = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    db.prepare('DELETE FROM sync_configs WHERE id = ?').run(id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getSyncLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { provider_id, user_id, limit } = req.query;
    let query = `
      SELECT sl.*, p.name as provider_name, u.username
      FROM sync_logs sl
      JOIN providers p ON p.id = sl.provider_id
      JOIN users u ON u.id = sl.user_id
      WHERE 1=1
    `;
    const params = [];

    if (provider_id) {
      query += ' AND sl.provider_id = ?';
      params.push(Number(provider_id));
    }

    if (user_id) {
      query += ' AND sl.user_id = ?';
      params.push(Number(user_id));
    }

    query += ' ORDER BY sl.sync_time DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(Number(limit));
    }

    const logs = db.prepare(query).all(...params);
    res.json(logs);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getStatistics = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

    const topChannels = db.prepare(`
      SELECT ss.views, ss.last_viewed, pc.name, pc.logo
      FROM stream_stats ss
      JOIN provider_channels pc ON pc.id = ss.channel_id
      ORDER BY ss.views DESC
      LIMIT 10
    `).all();

    const allStreams = await streamManager.getAll();

    // ⚡ Bolt: Hoist the prepared statement outside the loop to prevent parsing/compiling the SQL on every iteration.
    // This provides a massive speedup without the memory overhead of fetching tens of thousands of channels.
    const getLogoStmt = db.prepare('SELECT logo FROM provider_channels WHERE name = ? AND provider_id = ? LIMIT 1');

    const streams = allStreams.map(s => {
      // Find logo if possible (for Active Streams)
      let logo = null;
      if (s.channel_name && s.provider_id) {
          const ch = getLogoStmt.get(s.channel_name, s.provider_id);
          if (ch) logo = ch.logo;
      }
      return {
        ...s,
        logo: logo,
        duration: Math.floor((Date.now() - s.start_time) / 1000)
      };
    });

    const [cpuLoad, cpuInfo, memInfo, fsSize, netStats] = await Promise.all([
      si.currentLoad(),
      si.cpu(),
      si.mem(),
      si.fsSize(),
      si.networkStats()
    ]);

    const primaryFs = fsSize.find(fs => fs.mount === '/') || fsSize[0] || {};
    const primaryNet = netStats.find(net => net.operstate === 'up') || netStats[0] || {};

    // Calculate total bandwidth since app start
    let rxTotal = primaryNet.rx_bytes || 0;
    let txTotal = primaryNet.tx_bytes || 0;
    if (initialNetStats) {
       rxTotal = Math.max(0, rxTotal - initialNetStats.rx_bytes);
       txTotal = Math.max(0, txTotal - initialNetStats.tx_bytes);
    }

    const systemInfo = {
      cpu: {
        utilization: cpuLoad.currentLoad.toFixed(2),
        cores: cpuInfo.cores || cpuLoad.cpus.length
      },
      memory: {
        total: memInfo.total,
        used: memInfo.active,
        free: memInfo.available,
        utilization: ((memInfo.active / memInfo.total) * 100).toFixed(2)
      },
      hdd: {
        total: primaryFs.size || 0,
        used: primaryFs.used || 0,
        free: (primaryFs.size || 0) - (primaryFs.used || 0),
        utilization: primaryFs.use ? primaryFs.use.toFixed(2) : '0.00'
      },
      bandwidth: {
        rx_sec: primaryNet.rx_sec || 0,
        tx_sec: primaryNet.tx_sec || 0,
        rx_total: rxTotal,
        tx_total: txTotal
      }
    };

    res.json({
      active_streams: streams,
      top_channels: topChannels,
      system_info: systemInfo
    });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const resetStatistics = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM stream_stats').run();
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
