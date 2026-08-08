import db from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { isSafeUrl, redactUrl, providerSourceKey } from '../utils/helpers.js';
import { performSync, checkProviderExpiry, deleteProviderChannelCascade } from '../services/syncService.js';
import { updateProviderEpg } from '../services/epgService.js';
import { clearChannelsCache } from '../services/cacheService.js';
import { parseTimeshiftTimezone } from '../utils/timezone.js';
import { getProviderChannels, getProviderCategories } from './providerCatalogController.js';
import { importCategory, importCategories } from './providerCategoryImportController.js';

export { getProviderChannels, getProviderCategories, importCategory, importCategories };

const normalizeProviderBaseUrl = (url) => String(url || '').trim().replace(/\/+$/, '');
const isHttpUrl = (url) => /^https?:\/\//i.test(url);
const replaceDefaultEpgProviderUrl = (epgUrl, fromBase, toBase) => {
  const trimmed = String(epgUrl || '').trim();
  const defaultPath = `${fromBase}/xmltv.php`;
  if (trimmed === defaultPath || trimmed.startsWith(`${defaultPath}?`)) {
    return `${toBase}${trimmed.slice(fromBase.length)}`;
  }
  return trimmed;
};

const fetchProviderDetails = async (url, username, password) => {
  try {
    const baseUrl = url.trim().replace(/\/+$/, '');
    const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username.trim())}&password=${encodeURIComponent(password.trim())}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const resp = await fetchSafe(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (resp.ok) {
      const data = await resp.json();
      if (data && data.user_info && data.user_info.max_connections) {
        const maxCon = parseInt(data.user_info.max_connections, 10);
        if (!isNaN(maxCon)) {
          return maxCon;
        }
      }
    }
  } catch (e) {
    console.error('Failed to fetch provider details:', e.message);
  }
  return null;
};

export const getProviders = (req, res) => {
  try {
    if (!req.user.is_admin && !req.user.provider_access) {
      return res.status(403).json({error: 'Access denied'});
    }

    let { user_id } = req.query;

    if (!req.user.is_admin) {
        user_id = req.user.id;
    }

    let query = `
      SELECT p.*, u.username as owner_name
      FROM providers p
      LEFT JOIN users u ON u.id = p.user_id
    `;
    const params = [];

    if (user_id) {
      query += ' WHERE p.user_id = ?';
      params.push(Number(user_id));
    }

    const providers = db.prepare(query).all(...params);
    const safeProviders = providers.map(p => {
      let lastUpdate = p.last_epg_update || 0;

      let plainPassword = null;
      if (req.user.is_admin) {
        plainPassword = decrypt(p.password);
      }

      let backupUrls = [];
      try {
          if (p.backup_urls) {
              backupUrls = JSON.parse(p.backup_urls);
          }
      } catch { /* ignore */ }

      return {
        ...p,
        password: '********',
        plain_password: plainPassword || '********',
        epg_last_updated: lastUpdate,
        backup_urls: backupUrls
      };
    });
    res.json(safeProviders);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createProvider = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent, max_connections, use_mapped_epg_icon, timeshift_timezone } = req.body;
    if (!name || !url || !username || !password) return res.status(400).json({error: 'missing'});

    const parsedTimezone = parseTimeshiftTimezone(timeshift_timezone);
    if (parsedTimezone.error) return res.status(400).json({error: 'invalid_timeshift_timezone'});

    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL must start with http:// or https://'});
    }
    if (!(await isSafeUrl(url.trim()))) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL is unsafe (blocked)'});
    }

    // Process backup URLs
    let processedBackupUrls = '[]';
    if (backup_urls) {
        let urls = [];
        if (Array.isArray(backup_urls)) {
            urls = backup_urls;
        } else if (typeof backup_urls === 'string') {
            try {
                urls = JSON.parse(backup_urls);
            } catch {
                urls = backup_urls.split('\n');
            }
        }

        const validUrls = [];
        for (const u of urls) {
            const trimmed = u.trim();
            if (!trimmed) continue;

            if (!/^https?:\/\//i.test(trimmed)) {
                return res.status(400).json({error: 'invalid_url', message: `Backup URL must start with http:// or https://: ${trimmed}`});
            }

            if (!(await isSafeUrl(trimmed))) {
                return res.status(400).json({error: 'invalid_url', message: `Backup URL is unsafe or invalid (blocked): ${trimmed}`});
            }

            validUrls.push(trimmed);
        }
        processedBackupUrls = JSON.stringify(validUrls);
    }

    let finalEpgUrl = (epg_url || '').trim();
    if (finalEpgUrl) {
      if (!/^https?:\/\//i.test(finalEpgUrl)) {
        return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL must start with http:// or https://'});
      }
      if (!(await isSafeUrl(finalEpgUrl))) {
        return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL is unsafe (blocked)'});
      }
    }

    if (!finalEpgUrl) {
      try {
        const baseUrl = url.trim().replace(/\/+$/, '');
        const discoveredUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(username.trim())}&password=${encodeURIComponent(password.trim())}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetchSafe(discoveredUrl, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          finalEpgUrl = discoveredUrl;
        }
      } catch {
        /* ignore */
      }
    }

    // Auto-fetch max_connections if not provided explicitly (it could be an empty string)
    // If the user explicitly sets it to "0", we treat it as 0 (unlimited)
    let finalMaxConnections;
    if (max_connections !== undefined && max_connections !== '') {
        finalMaxConnections = Number(max_connections);
    } else {
        // Only auto-fetch if the field was left empty
        finalMaxConnections = 0;
        const fetchedLimit = await fetchProviderDetails(url, username, password);
        if (fetchedLimit !== null) {
            finalMaxConnections = fetchedLimit;
        }
    }

    const encryptedPassword = encrypt(password.trim());

    const info = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent, max_connections, use_mapped_epg_icon, timeshift_timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      url.trim(),
      username.trim(),
      encryptedPassword,
      finalEpgUrl,
      user_id ? Number(user_id) : null,
      epg_update_interval ? Number(epg_update_interval) : 86400,
      epg_enabled !== undefined ? (epg_enabled ? 1 : 0) : 1,
      processedBackupUrls,
      user_agent ? user_agent.trim() : null,
      finalMaxConnections,
      use_mapped_epg_icon ? 1 : 0,
      parsedTimezone.value
    );

    // Check expiry
    await checkProviderExpiry(info.lastInsertRowid);

    // Trigger EPG update if enabled
    if (epg_enabled === undefined || epg_enabled) {
      updateProviderEpg(info.lastInsertRowid).catch(err => console.error(`Initial EPG update failed for provider ${info.lastInsertRowid}:`, err.message));
    }

    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const updateProvider = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent, max_connections, use_mapped_epg_icon, timeshift_timezone } = req.body;
    if (!name || !url || !username || !password) {
      return res.status(400).json({error: 'missing fields'});
    }

    if (!/^https?:\/\//i.test(url.trim())) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL must start with http:// or https://'});
    }
    if (!(await isSafeUrl(url.trim()))) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL is unsafe (blocked)'});
    }

    if (epg_url) {
      if (!/^https?:\/\//i.test(epg_url.trim())) {
        return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL must start with http:// or https://'});
      }
      if (!(await isSafeUrl(epg_url.trim()))) {
        return res.status(400).json({error: 'invalid_epg_url', message: 'EPG URL is unsafe (blocked)'});
      }
    }

    const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'provider not found'});

    const parsedTimezone = parseTimeshiftTimezone(timeshift_timezone);
    if (parsedTimezone.error) return res.status(400).json({error: 'invalid_timeshift_timezone'});
    const nextTimezone = parsedTimezone.provided ? parsedTimezone.value : (existing.timeshift_timezone || null);

    const nextUserId = user_id !== undefined ? (user_id ? Number(user_id) : null) : existing.user_id;
    if (nextUserId !== null && !Number.isInteger(nextUserId)) {
      return res.status(400).json({error: 'invalid user_id'});
    }
    if (user_id !== undefined && nextUserId !== null && !db.prepare('SELECT id FROM users WHERE id = ?').get(nextUserId)) {
      return res.status(404).json({error: 'User not found'});
    }
    const ownerChanged = nextUserId !== existing.user_id;

    // Process backup URLs
    let processedBackupUrls = existing.backup_urls || '[]';
    if (backup_urls !== undefined) {
        let urls = [];
        if (Array.isArray(backup_urls)) {
            urls = backup_urls;
        } else if (typeof backup_urls === 'string') {
            try {
                urls = JSON.parse(backup_urls);
            } catch {
                urls = backup_urls.split('\n');
            }
        }

        const validUrls = [];
        for (const u of urls) {
            const trimmed = u.trim();
            if (!trimmed) continue;

            if (!/^https?:\/\//i.test(trimmed)) {
                return res.status(400).json({error: 'invalid_url', message: `Backup URL must start with http:// or https://: ${trimmed}`});
            }

            if (!(await isSafeUrl(trimmed))) {
                return res.status(400).json({error: 'invalid_url', message: `Backup URL is unsafe or invalid (blocked): ${trimmed}`});
            }

            validUrls.push(trimmed);
        }
        processedBackupUrls = JSON.stringify(validUrls);
    }

    let finalPassword = existing.password;
    if (password.trim() !== '********') {
       finalPassword = encrypt(password.trim());
    }

    let finalEpgUrl = (epg_url || '').trim();
    if (!finalEpgUrl) {
       try {
        const baseUrl = url.trim().replace(/\/+$/, '');
        const pwdToUse = password.trim() === '********' ? decrypt(existing.password) : password.trim();
        const usrToUse = username.trim();
        const discoveredUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(usrToUse)}&password=${encodeURIComponent(pwdToUse)}`;
        finalEpgUrl = discoveredUrl;
       } catch {}
    }

    // Auto-fetch max_connections if not provided or 0
    let finalMaxConnections = max_connections ? Number(max_connections) : (existing.max_connections || 0);

    // If current limit is 0 (unlimited) or we are updating credentials, try to fetch
    // Use the password we are about to save (or existing if not changed)
    const pwdForFetch = password.trim() === '********' ? decrypt(existing.password) : password.trim();

    // Only attempt fetch if we don't have a specific override in the request (i.e., user sent 0 or nothing)
    // AND if we have credentials
    if ((!max_connections || Number(max_connections) === 0) && pwdForFetch) {
        const fetchedLimit = await fetchProviderDetails(url, username, pwdForFetch);
        if (fetchedLimit !== null) {
            finalMaxConnections = fetchedLimit;
        }
    }

    let revokedAssignments = 0;
    let disabledSyncConfigs = 0;
    let retainedSyncGrants = 0;
    db.transaction(() => {
      db.prepare(`
        UPDATE providers
        SET name = ?, url = ?, username = ?, password = ?, epg_url = ?, user_id = ?, epg_update_interval = ?, epg_enabled = ?, backup_urls = ?, user_agent = ?, max_connections = ?, use_mapped_epg_icon = ?, timeshift_timezone = ?
        WHERE id = ?
      `).run(
        name.trim(),
        url.trim(),
        username.trim(),
        finalPassword,
        finalEpgUrl,
        nextUserId,
        epg_update_interval ? Number(epg_update_interval) : existing.epg_update_interval,
        epg_enabled !== undefined ? (epg_enabled ? 1 : 0) : existing.epg_enabled,
        processedBackupUrls,
        user_agent ? user_agent.trim() : null,
        finalMaxConnections,
        use_mapped_epg_icon !== undefined ? (use_mapped_epg_icon ? 1 : 0) : existing.use_mapped_epg_icon,
        nextTimezone,
        id
      );

      if (ownerChanged) {
        db.prepare(`
          UPDATE user_channels
          SET granted_by_admin = 0,
              authorization_revoked = 0
          WHERE provider_channel_id IN (
            SELECT id FROM provider_channels WHERE provider_id = ?
          )
            AND EXISTS (
              SELECT 1
              FROM user_categories cat
              WHERE cat.id = user_channels.user_category_id
                AND cat.user_id IS ?
            )
        `).run(id, nextUserId);

        db.prepare(`
          UPDATE user_channels
          SET authorization_revoked = 0
          WHERE granted_by_admin = 1
            AND provider_channel_id IN (
              SELECT id FROM provider_channels WHERE provider_id = ?
            )
        `).run(id);

        revokedAssignments = db.prepare(`
          UPDATE user_channels
          SET authorization_revoked = 1
          WHERE authorization_revoked = 0
            AND granted_by_admin = 0
            AND provider_channel_id IN (
              SELECT id FROM provider_channels WHERE provider_id = ?
            )
            AND NOT EXISTS (
              SELECT 1
              FROM user_categories cat
              WHERE cat.id = user_channels.user_category_id
                AND cat.user_id IS ?
            )
        `).run(id, nextUserId).changes;

        db.prepare(`
          UPDATE sync_configs
          SET granted_by_admin = 0
          WHERE provider_id = ? AND user_id IS ?
        `).run(id, nextUserId);

        disabledSyncConfigs = db.prepare(`
          UPDATE sync_configs
          SET enabled = 0
          WHERE provider_id = ?
            AND user_id IS NOT ?
            AND granted_by_admin = 0
            AND enabled = 1
        `).run(id, nextUserId).changes;

        retainedSyncGrants = db.prepare(`
          SELECT COUNT(*) AS count
          FROM sync_configs
          WHERE provider_id = ?
            AND user_id IS NOT ?
            AND granted_by_admin = 1
            AND enabled = 1
        `).get(id, nextUserId).count;

        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
          req.ip || 'unknown',
          'provider_owner_changed',
          `Provider ${id} owner changed; revoked ${revokedAssignments} ungranted assignment(s); disabled ${disabledSyncConfigs} ungranted sync config(s); retained ${retainedSyncGrants} explicit sync grant(s)`,
          Math.floor(Date.now() / 1000)
        );
      }
    })();

    if (ownerChanged) clearChannelsCache();

    // Check expiry
    await checkProviderExpiry(id);

    // Trigger EPG update if enabled
    const isEpgEnabled = epg_enabled !== undefined ? epg_enabled : existing.epg_enabled;

    if (isEpgEnabled) {
      updateProviderEpg(id).catch(err => console.error(`EPG update failed for provider ${id}:`, err.message));
    }

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const bulkUpdateProviderUrls = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

    const fromBase = normalizeProviderBaseUrl(req.body.from_url || req.body.old_url);
    const toBase = normalizeProviderBaseUrl(req.body.to_url || req.body.new_url);

    if (!fromBase || !toBase) return res.status(400).json({error: 'missing fields'});
    if (!isHttpUrl(fromBase) || !isHttpUrl(toBase)) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URLs must start with http:// or https://'});
    }
    if (fromBase === toBase) return res.status(400).json({error: 'same_url'});
    if (!(await isSafeUrl(toBase))) {
      return res.status(400).json({error: 'invalid_url', message: 'Provider URL is unsafe (blocked)'});
    }

    const providers = db.prepare('SELECT id, url, epg_url FROM providers').all();
    const matches = providers.filter(p => normalizeProviderBaseUrl(p.url) === fromBase);
    const update = db.prepare('UPDATE providers SET url = ?, epg_url = ? WHERE id = ?');

    db.transaction(() => {
      for (const provider of matches) {
        update.run(toBase, replaceDefaultEpgProviderUrl(provider.epg_url, fromBase, toBase), provider.id);
      }
    })();

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
      req.ip,
      'provider_url_bulk_update',
      `User ${req.user.username} changed provider URLs from ${redactUrl(fromBase)} to ${redactUrl(toBase)} (${matches.length})`,
      Math.floor(Date.now() / 1000)
    );
    clearChannelsCache();

    res.json({ success: true, updated: matches.length });
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteProvider = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const providerRow = db.prepare('SELECT url FROM providers WHERE id = ?').get(id);

    db.transaction(() => {
      const providerChannels = db.prepare(
        'SELECT id FROM provider_channels WHERE provider_id = ? ORDER BY id'
      ).all(id);
      for (const channel of providerChannels) {
        deleteProviderChannelCascade(db, id, channel.id);
      }

      db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM provider_sync_state WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM provider_icon_cache WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);

      // Episode data is shared per upstream panel; drop it only when no other
      // provider row points at the same panel anymore.
      if (providerRow) {
        const sourceKey = providerSourceKey(providerRow.url);
        const stillUsed = db.prepare('SELECT id, url FROM providers').all()
          .some(p => providerSourceKey(p.url) === sourceKey);
        if (!stillUsed) {
          db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ?').run(sourceKey);
          db.prepare('DELETE FROM provider_series_state WHERE source_key = ?').run(sourceKey);
        }
      }
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const syncProvider = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_id, allow_cross_owner, restore_revoked_assignments } = req.body;

    if (!user_id) {
      return res.status(400).json({error: 'user_id required'});
    }

    if (!req.user.is_admin) {
        return res.status(403).json({error: 'Access denied'});
    }

    const result = await performSync(id, user_id, {
      mode: 'manual',
      allowCrossOwner: allow_cross_owner === true,
      restoreRevokedAssignments: restore_revoked_assignments === true
    });

    // Also trigger EPG update
    updateProviderEpg(id).catch(err => console.error(`Manual sync EPG update failed for provider ${id}:`, err.message));

    if (result.errorMessage) {
      return res.status(500).json({error: result.errorMessage});
    }

    res.json({
      success: true,
      channels_added: result.channelsAdded,
      channels_updated: result.channelsUpdated,
      categories_added: result.categoriesAdded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};
