import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import db from '../database/db.js';
import { encryptWithPassword, decryptWithPassword, decrypt, encrypt } from '../utils/crypto.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { clearSettingsCache, isSafeUrl, resolveAssignmentGrant } from '../utils/helpers.js';
import { getGeoIpUpdatePlan, reloadGeoIpData, runGeoIpUpdateProcess } from '../services/geoIpUpdateService.js';
import { parseTimeshiftTimezone } from '../utils/timezone.js';
import {
  normalizeAssignmentOrigin,
  mergeAssignmentGroups,
  upsertMergedUserChannelAssignment
} from '../services/userChannelAssignmentService.js';
import {
  validateMappingAssignmentRelationship,
  validateStoredMappingAssignment
} from '../services/categoryMappingService.js';

export const exportData = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const user_id = req.body.user_id || req.query.user_id;
    const password = req.body.password;

    if (!password) {
      return res.status(400).json({error: 'Password required for encryption'});
    }

    const exportData = {
      version: 2,
      assignment_provenance_version: 1,
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
          providerIds.push(p.id);
       }
       exportData.providers = providers;

       if (providerIds.length > 0) {
          // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
          const provPlaceholders = Array(providerIds.length).fill('?').join(',');

          const channels = db.prepare(`SELECT * FROM provider_channels WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          exportData.channels = channels;

          const mappings = db.prepare(`SELECT * FROM category_mappings WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          exportData.mappings = mappings;

          const syncs = db.prepare(`SELECT * FROM sync_configs WHERE provider_id IN (${provPlaceholders})`).all(...providerIds);
          exportData.sync_configs = syncs;
       }

       const categories = db.prepare(`SELECT * FROM user_categories WHERE user_id IN (${userPlaceholders})`).all(...userIds);
       exportData.categories = categories;

       const userChannels = db.prepare(`
         SELECT uc.*
         FROM user_channels uc
         JOIN user_categories cat ON cat.id = uc.user_category_id
         WHERE cat.user_id IN (${userPlaceholders})
       `).all(...userIds);
       for (const userChannel of userChannels) {
          exportData.channels.push({...userChannel, type: 'user_assignment'});
       }
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

export const updateGeoIpDatabase = async (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});

    let licenseKey = req.body?.license_key;
    const force = req.body?.force === true || req.body?.force === 'true';

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

    const updatePlan = await getGeoIpUpdatePlan(licenseKey, { force });
    if (!updatePlan.updateAvailable) {
        return res.json({
            success: true,
            up_to_date: true,
            message: 'GeoIP database is already up to date.'
        });
    }

    runGeoIpUpdateProcess(licenseKey, { force: updatePlan.forceRequired })
        .then(async () => {
            console.info('GeoIP database updated successfully.');
            try {
                await reloadGeoIpData();
                console.info('GeoIP in-memory cache reloaded successfully.');
            } catch (e) {
                console.error('Failed to reload GeoIP cache:', e);
            }
            db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
                req.ip, 'GeoIP Update', 'Database updated successfully', Math.floor(Date.now() / 1000)
            );
        })
        .catch((e) => {
            console.error('GeoIP update failed:', e.message);
            db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
                req.ip, 'GeoIP Update Failed', e.message, Math.floor(Date.now() / 1000)
            );
        });

    res.json({
        success: true,
        update_available: true,
        message: 'GeoIP database update started in the background.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

async function decodeImportFile(tempPath, password) {
  const encryptedData = await fs.promises.readFile(tempPath);

  let compressed;
  try {
    compressed = decryptWithPassword(encryptedData, password);
  } catch {
    return { error: { error: 'Decryption failed. Wrong password?' } };
  }

  let jsonStr;
  try {
    // Security: Use maxOutputLength to prevent Zip Bomb / DoS attacks
    // Limit to 200MB of uncompressed JSON data
    jsonStr = zlib.gunzipSync(compressed, { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8');
  } catch {
    return { error: { error: 'Decompression failed or file too large.' } };
  }

  return { data: JSON.parse(jsonStr) };
}

async function validateImportedProviders(providers) {
  for (const provider of providers) {
    const parsedTimezone = parseTimeshiftTimezone(provider.timeshift_timezone);
    if (parsedTimezone.error) return { error: 'invalid_timeshift_timezone' };

    if (provider.url && !(await isSafeUrl(provider.url))) {
      return { error: 'invalid_url', message: `Provider URL is unsafe: ${provider.url}` };
    }
    if (provider.epg_url && !(await isSafeUrl(provider.epg_url))) {
      return { error: 'invalid_url', message: `EPG URL is unsafe: ${provider.epg_url}` };
    }

    if (provider.backup_urls) {
      let urls = [];
      try {
        urls = Array.isArray(provider.backup_urls)
          ? provider.backup_urls
          : JSON.parse(provider.backup_urls);
      } catch {
        if (typeof provider.backup_urls === 'string') urls = provider.backup_urls.split('\n');
      }

      if (Array.isArray(urls)) {
        for (const url of urls) {
          const trimmed = url.trim();
          if (trimmed && !(await isSafeUrl(trimmed))) {
            return { error: 'invalid_url', message: `Backup URL is unsafe: ${trimmed}` };
          }
        }
      }
    }
  }

  return null;
}

export const importData = async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
  let tempPath = null;
  try {
    const { password } = req.body;
    const allowCrossOwner = req.body?.allow_cross_owner === true ||
      req.body?.allow_cross_owner === 'true';
    if (!req.file || !password) {
      return res.status(400).json({error: 'File and password required'});
    }

    tempPath = req.file.path;
    const decoded = await decodeImportFile(tempPath, password);
    if (decoded.error) return res.status(400).json(decoded.error);

    const importData = decoded.data;

    if (!Array.isArray(importData.users)) {
      return res.status(400).json({error: 'Invalid export file format'});
    }
    const trustedModernFormat = Number(importData.version) === 2 &&
      Number(importData.assignment_provenance_version) === 1;

    const providerValidationError = await validateImportedProviders(importData.providers || []);
    if (providerValidationError) return res.status(400).json(providerValidationError);

    const stats = {
      users_imported: 0,
      users_skipped: 0,
      providers: 0,
      categories: 0,
      channels: 0,
      channels_merged: 0,
      channels_skipped: 0,
      channels_hidden: 0,
      channels_authorization_revoked: 0
    };

    db.transaction(() => {
      const userIdMap = new Map();
      const providerIdMap = new Map();
      const categoryIdMap = new Map();
      const providerChannelIdMap = new Map();
      const providerOwnerMap = new Map();
      const categoryOwnerMap = new Map();
      const providerChannelOwnerMap = new Map();

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
        INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, expiry_date, backup_urls, user_agent, max_connections, timeshift_timezone)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const p of importData.providers || []) {
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
          p.max_connections || 0,
          parseTimeshiftTimezone(p.timeshift_timezone).value
        );

        providerIdMap.set(p.id, info.lastInsertRowid);
        providerOwnerMap.set(info.lastInsertRowid, newUserId);
        stats.providers++;
      }

      const provChannels = (importData.channels || []).filter(c => !c.type && providerIdMap.has(c.provider_id));

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
          normalizeContainerExtension(ch.mime_type, ch.stream_type === 'live' ? 'ts' : 'mp4'),
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
        providerChannelOwnerMap.set(info.lastInsertRowid, providerOwnerMap.get(newProvId));
      }

      const insertCategoryStmt = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)');

      for (const cat of importData.categories || []) {
        const newUserId = userIdMap.get(cat.user_id);
        if (!newUserId) continue;

        const catType = cat.type || 'live';
        const info = insertCategoryStmt.run(newUserId, cat.name, cat.is_adult, cat.sort_order, catType);
        categoryIdMap.set(cat.id, info.lastInsertRowid);
        categoryOwnerMap.set(info.lastInsertRowid, newUserId);
        stats.categories++;
      }

      const insertMappingStmt = db.prepare(`
        INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const mappingIdMap = new Map();
      const mappingSourceMap = new Map();

      for (const m of importData.mappings || []) {
        const newProvId = providerIdMap.get(m.provider_id);
        const newUserId = userIdMap.get(m.user_id);
        const newUserCatId = m.user_category_id ? categoryIdMap.get(m.user_category_id) : null;

        if (newProvId && newUserId) {
           const info = insertMappingStmt.run(newProvId, newUserId, m.provider_category_id, m.provider_category_name, newUserCatId, m.auto_created, m.category_type || 'live');
           mappingIdMap.set(Number(m.id), info.lastInsertRowid);
           mappingSourceMap.set(Number(m.id), {
             ...m,
             new_id: Number(info.lastInsertRowid),
             new_provider_id: Number(newProvId),
             new_user_id: Number(newUserId),
             new_user_category_id: newUserCatId ? Number(newUserCatId) : null
           });
        }
      }

      const insertSyncConfigStmt = db.prepare(`
        INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, last_sync, next_sync, auto_add_categories, auto_add_channels, sync_series_episodes, granted_by_admin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const s of importData.sync_configs || []) {
        const newProvId = providerIdMap.get(s.provider_id);
        const newUserId = userIdMap.get(s.user_id);

        if (newProvId && newUserId) {
          const grant = resolveAssignmentGrant({
            categoryOwnerId: newUserId,
            providerOwnerId: providerOwnerMap.get(newProvId),
            isAdmin: true,
            allowExplicitAdminGrant: allowCrossOwner &&
              Number(s.granted_by_admin) === 1
          });
          insertSyncConfigStmt.run(
            newProvId,
            newUserId,
            grant === null ? 0 : (s.enabled ? 1 : 0),
            s.sync_interval,
            0,
            0,
            s.auto_add_categories,
            s.auto_add_channels,
            s.sync_series_episodes === undefined ? 1 : (s.sync_series_episodes ? 1 : 0),
            grant === 1 ? 1 : 0
          );
        }
      }

      const userAssignments = (importData.channels || []).filter(c => c.type === 'user_assignment');
      const getProviderChannel = db.prepare(`
        SELECT provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type
        FROM provider_channels WHERE id = ?
      `);
      const getMapping = db.prepare(`
        SELECT id, provider_id, user_id, user_category_id, provider_category_id,
               COALESCE(category_type, 'live') AS category_type
        FROM category_mappings
        WHERE id = ?
      `);
      const sourceProviderChannels = new Map(
        (importData.channels || []).filter(channel => !channel.type).map(channel => [Number(channel.id), channel])
      );
      const sourceCategories = new Map(
        (importData.categories || []).map(category => [Number(category.id), category])
      );
      const candidates = [];

      for (const ua of userAssignments) {
        const newUserCatId = categoryIdMap.get(ua.user_category_id);
        const newProvChannelId = providerChannelIdMap.get(ua.provider_channel_id);
        if (!newUserCatId || !newProvChannelId) {
          stats.channels_skipped++;
          continue;
        }

        const grant = resolveAssignmentGrant({
          categoryOwnerId: categoryOwnerMap.get(newUserCatId),
          providerOwnerId: providerChannelOwnerMap.get(newProvChannelId),
          isAdmin: true,
          allowExplicitAdminGrant: allowCrossOwner && Number(ua.granted_by_admin) === 1
        });
        const requestedOrigin = trustedModernFormat
          ? normalizeAssignmentOrigin(ua.assignment_origin, 'legacy')
          : 'imported';
        const sourceMappingId = Number(ua.mapping_id);
        const sourceMapping = mappingSourceMap.get(sourceMappingId);
        const remappedMappingId = requestedOrigin === 'mapping' ? mappingIdMap.get(sourceMappingId) : null;
        const sourceChannel = sourceProviderChannels.get(Number(ua.provider_channel_id));
        const sourceCategory = sourceCategories.get(Number(ua.user_category_id));
        const restoredChannel = getProviderChannel.get(newProvChannelId);
        const sourceValid = requestedOrigin === 'mapping' && sourceMapping && sourceChannel && sourceCategory &&
          validateMappingAssignmentRelationship({
            mapping: sourceMapping,
            userId: sourceMapping.user_id ?? sourceCategory.user_id,
            userCategoryId: ua.user_category_id,
            userCategoryType: sourceCategory.type,
            providerId: sourceChannel.provider_id,
            providerCategoryId: sourceChannel.original_category_id,
            providerStreamType: sourceChannel.stream_type
          });
        const restoredValid = sourceValid && remappedMappingId && restoredChannel &&
          validateStoredMappingAssignment(db, {
            mappingId: remappedMappingId,
            userId: categoryOwnerMap.get(newUserCatId),
            userCategoryId: newUserCatId,
            providerChannelId: newProvChannelId
          });
        const validMapping = Boolean(sourceValid && restoredValid &&
          Number(mappingSourceMap.get(sourceMappingId)?.new_user_category_id) === Number(newUserCatId) &&
          Number(mappingSourceMap.get(sourceMappingId)?.new_provider_id) === Number(restoredChannel?.provider_id) &&
          Number(getMapping.get(Number(remappedMappingId))?.provider_category_id) === Number(restoredChannel?.original_category_id));
        const authorizationRevoked = grant === null ||
          (Number(ua.authorization_revoked) === 1 && grant !== 1) ? 1 : 0;
        candidates.push({
          id: ua.id,
          user_category_id: Number(newUserCatId),
          provider_channel_id: Number(newProvChannelId),
          sort_order: ua.sort_order,
          custom_name: ua.custom_name || '',
          is_hidden: Number(ua.is_hidden) === 1 ? 1 : 0,
          assignment_origin: validMapping ? 'mapping' : (requestedOrigin === 'mapping' ? 'legacy' : requestedOrigin),
          mapping_id: validMapping ? Number(remappedMappingId) : null,
          granted_by_admin: grant === 1 ? 1 : 0,
          authorization_revoked: authorizationRevoked,
          grant_valid: grant === 1,
          mapping_valid: validMapping
        });
      }

      const grouped = mergeAssignmentGroups(candidates, { preserveLowestId: true });
      const getAssignmentById = db.prepare('SELECT id FROM user_channels WHERE id = ?');
      for (const group of grouped.groups) {
        const candidate = { ...group.candidate };
        candidate.id = group.validIds.find(id => !getAssignmentById.get(id)) || null;
        const result = upsertMergedUserChannelAssignment(db, candidate, {
          preserveId: true,
          mappingValidator: mappingId => validateStoredMappingAssignment(db, {
            mappingId,
            userId: categoryOwnerMap.get(candidate.user_category_id),
            userCategoryId: candidate.user_category_id,
            providerChannelId: candidate.provider_channel_id
          })
        });
        if (result.skipped) {
          stats.channels_skipped++;
          continue;
        }
        stats.channels += result.inserted;
        stats.channels_merged += group.duplicateCount + result.merged;
        stats.channels_hidden += Number(result.hidden) === 1 ? 1 : 0;
        stats.channels_authorization_revoked += Number(result.authorization_revoked) === 1 ? 1 : 0;
      }

    })();

    if (stats.channels_merged === 0) delete stats.channels_merged;
    res.json({success: true, stats});

  } catch (e) {
    console.error('Import error:', e);
    res.status(500).json({error: e.message});
  } finally {
    if (tempPath) {
      try { await fs.promises.unlink(tempPath); } catch {}
    }
  }
};
