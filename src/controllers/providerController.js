import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import db from '../database/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { isSafeUrl, isAdultCategory } from '../utils/helpers.js';
import { performSync, checkProviderExpiry } from '../services/syncService.js';
import { EPG_CACHE_DIR } from '../config/constants.js';

export const getProviders = (req, res) => {
  try {
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
      let lastUpdate = 0;
      if (p.epg_url) {
         const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${p.id}.xml`);
         if (fs.existsSync(cacheFile)) {
             try {
                lastUpdate = Math.floor(fs.statSync(cacheFile).mtimeMs / 1000);
             } catch(e) {}
         }
      }

      let plainPassword = null;
      if (req.user.is_admin) {
        plainPassword = decrypt(p.password);
      }

      let backupUrls = [];
      try {
          if (p.backup_urls) {
              backupUrls = JSON.parse(p.backup_urls);
          }
      } catch (e) { /* ignore */ }

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
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent } = req.body;
    if (!name || !url || !username || !password) return res.status(400).json({error: 'missing'});

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
            } catch (e) {
                urls = backup_urls.split('\n');
            }
        }

        const validUrls = [];
        for (const u of urls) {
            const trimmed = u.trim();
            if (trimmed && /^https?:\/\//i.test(trimmed)) {
                if (await isSafeUrl(trimmed)) {
                    validUrls.push(trimmed);
                }
            }
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
        const resp = await fetch(discoveredUrl, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);

        if (resp.ok) {
          finalEpgUrl = discoveredUrl;
          console.log('✅ Auto-discovered EPG URL:', finalEpgUrl);
        }
      } catch (e) {
        console.log('⚠️ EPG Auto-discovery failed:', e.message);
      }
    }

    const encryptedPassword = encrypt(password.trim());

    const info = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      user_agent ? user_agent.trim() : null
    );

    // Check expiry
    await checkProviderExpiry(info.lastInsertRowid);

    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const updateProvider = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, backup_urls, user_agent } = req.body;
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

    // Process backup URLs
    let processedBackupUrls = existing.backup_urls || '[]';
    if (backup_urls !== undefined) {
        let urls = [];
        if (Array.isArray(backup_urls)) {
            urls = backup_urls;
        } else if (typeof backup_urls === 'string') {
            try {
                urls = JSON.parse(backup_urls);
            } catch (e) {
                urls = backup_urls.split('\n');
            }
        }

        const validUrls = [];
        for (const u of urls) {
            const trimmed = u.trim();
            if (trimmed && /^https?:\/\//i.test(trimmed)) {
                if (await isSafeUrl(trimmed)) {
                    validUrls.push(trimmed);
                }
            }
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
       } catch(e) {}
    }

    db.prepare(`
      UPDATE providers
      SET name = ?, url = ?, username = ?, password = ?, epg_url = ?, user_id = ?, epg_update_interval = ?, epg_enabled = ?, backup_urls = ?, user_agent = ?
      WHERE id = ?
    `).run(
      name.trim(),
      url.trim(),
      username.trim(),
      finalPassword,
      finalEpgUrl,
      user_id !== undefined ? (user_id ? Number(user_id) : null) : existing.user_id,
      epg_update_interval ? Number(epg_update_interval) : existing.epg_update_interval,
      epg_enabled !== undefined ? (epg_enabled ? 1 : 0) : existing.epg_enabled,
      processedBackupUrls,
      user_agent ? user_agent.trim() : null,
      id
    );

    // Check expiry
    await checkProviderExpiry(id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteProvider = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);

    db.transaction(() => {
      db.prepare('DELETE FROM user_channels WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(id);
      db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(id);
      db.prepare('DELETE FROM stream_stats WHERE channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(id);
      db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);

      db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const syncProvider = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({error: 'user_id required'});
    }

    if (!req.user.is_admin) {
        return res.status(403).json({error: 'Access denied'});
    }

    const result = await performSync(id, user_id, true);

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

export const getProviderChannels = (req, res) => {
  try {
    const { type, page, limit, search } = req.query;
    const providerId = Number(req.params.id);

    if (page || limit || search) {
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 50;
      const offset = (pageNum - 1) * limitNum;
      const searchTerm = (search || '').trim().toLowerCase();

      let baseQuery = 'FROM provider_channels WHERE provider_id = ?';
      const params = [providerId];

      if (type) {
        baseQuery += ' AND stream_type = ?';
        params.push(type);
      }

      if (searchTerm) {
        baseQuery += ' AND lower(name) LIKE ?';
        params.push(`%${searchTerm}%`);
      }

      const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
      const total = db.prepare(countQuery).get(...params).count;

      const dataQuery = `SELECT * ${baseQuery} ORDER BY original_sort_order ASC, name ASC LIMIT ? OFFSET ?`;
      const rows = db.prepare(dataQuery).all(...params, limitNum, offset);

      return res.json({
        channels: rows,
        total: total,
        page: pageNum,
        limit: limitNum
      });
    }

    let query = 'SELECT * FROM provider_channels WHERE provider_id = ?';
    const params = [providerId];

    if (type) {
        query += ' AND stream_type = ?';
        params.push(type);
    }

    query += ' ORDER BY original_sort_order ASC, name ASC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getProviderCategories = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = req.query.type || 'live'; // 'live', 'movie', 'series'

    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'Provider not found'});

    const decryptedPassword = decrypt(provider.password);

    let categories = [];
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(decryptedPassword)}`;
    let action = 'get_live_categories';

    if(type === 'movie') action = 'get_vod_categories';
    if(type === 'series') action = 'get_series_categories';

    try {
      const apiUrl = `${baseUrl}/player_api.php?${authParams}&action=${action}`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    let streamType = 'live';
    if(type === 'movie') streamType = 'movie';
    if(type === 'series') streamType = 'series';

    const localCats = db.prepare(`
      SELECT DISTINCT original_category_id,
             COUNT(*) as channel_count
      FROM provider_channels
      WHERE provider_id = ? AND stream_type = ? AND original_category_id > 0
      GROUP BY original_category_id
      ORDER BY channel_count DESC
    `).all(id, streamType);

    const localCatsMap = new Map();
    for (const l of localCats) {
      localCatsMap.set(Number(l.original_category_id), l);
    }

    const merged = categories.map(cat => {
      const local = localCatsMap.get(Number(cat.category_id));
      const isAdult = isAdultCategory(cat.category_name);

      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0,
        is_adult: isAdult,
        category_type: type
      };
    });

    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};

export const importCategory = async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, category_id, category_name, import_channels, type } = req.body;
    const catType = type || 'live';

    if (!user_id || !category_id || !category_name) {
      return res.status(400).json({error: 'Missing required fields'});
    }

    if (!req.user.is_admin) {
        if (Number(user_id) !== req.user.id) return res.status(403).json({error: 'Access denied'});
        const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
        if (!provider || provider.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const isAdult = isAdultCategory(category_name) ? 1 : 0;

    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(user_id);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(user_id, category_name, isAdult, newSortOrder, catType);
    const newCategoryId = catInfo.lastInsertRowid;

    db.prepare(`
      INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(provider_id, user_id, provider_category_id, category_type)
      DO UPDATE SET user_category_id = excluded.user_category_id
    `).run(providerId, user_id, Number(category_id), category_name, newCategoryId, catType);

    if (import_channels) {
      let streamType = 'live';
      if(catType === 'movie') streamType = 'movie';
      if(catType === 'series') streamType = 'series';

      const channels = db.prepare(`
        SELECT id FROM provider_channels
        WHERE provider_id = ? AND original_category_id = ? AND stream_type = ?
        ORDER BY original_sort_order ASC, name ASC
      `).all(providerId, Number(category_id), streamType);

      const insertChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

      db.transaction(() => {
        channels.forEach((ch, idx) => {
          insertChannel.run(newCategoryId, ch.id, idx);
        });
      })();

      res.json({
        success: true,
        category_id: newCategoryId,
        channels_imported: channels.length,
        is_adult: isAdult
      });
    } else {
      res.json({
        success: true,
        category_id: newCategoryId,
        channels_imported: 0,
        is_adult: isAdult
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};

export const importCategories = async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, categories } = req.body;

    if (!user_id || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({error: 'Missing required fields or invalid categories'});
    }

    if (!req.user.is_admin) {
        if (Number(user_id) !== req.user.id) return res.status(403).json({error: 'Access denied'});
        const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
        if (!provider || provider.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const results = [];
    let totalChannels = 0;
    let totalCategories = 0;

    const insertUserCategory = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)');
    const insertChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');
    const getMaxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?');

    // Pre-fetch channels for all categories being imported to avoid N+1 queries
    const categoriesToImportChannels = categories.filter(c => c.import_channels && c.id);
    const categoryIds = [...new Set(categoriesToImportChannels.map(c => Number(c.id)))];
    const channelsMap = new Map();

    if (categoryIds.length > 0) {
      const allChannels = db.prepare(`
        SELECT id, original_category_id, stream_type FROM provider_channels
        WHERE provider_id = ? AND original_category_id IN (${categoryIds.map(() => '?').join(',')})
        ORDER BY original_sort_order ASC, name ASC
      `).all(providerId, ...categoryIds);

      allChannels.forEach(ch => {
        const key = `${ch.original_category_id}_${ch.stream_type}`;
        if (!channelsMap.has(key)) channelsMap.set(key, []);
        channelsMap.get(key).push(ch);
      });
    }

    db.transaction(() => {
      let maxSort = getMaxSort.get(user_id).max_sort;

      for (const cat of categories) {
        if (!cat.id || !cat.name) continue;

        const catType = cat.type || 'live';
        const isAdult = isAdultCategory(cat.name) ? 1 : 0;
        maxSort++;

        const catInfo = insertUserCategory.run(user_id, cat.name, isAdult, maxSort, catType);
        const newCategoryId = catInfo.lastInsertRowid;
        totalCategories++;

        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
          VALUES (?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(provider_id, user_id, provider_category_id, category_type)
          DO UPDATE SET user_category_id = excluded.user_category_id
        `).run(providerId, user_id, Number(cat.id), cat.name, newCategoryId, catType);

        let channelsImported = 0;
        if (cat.import_channels) {
          let streamType = 'live';
          if(catType === 'movie') streamType = 'movie';
          if(catType === 'series') streamType = 'series';

          const channels = channelsMap.get(`${Number(cat.id)}_${streamType}`) || [];

          channels.forEach((ch, idx) => {
            insertChannel.run(newCategoryId, ch.id, idx);
          });
          channelsImported = channels.length;
          totalChannels += channelsImported;
        }

        results.push({
          category_id: cat.id,
          new_id: newCategoryId,
          name: cat.name,
          channels_imported: channelsImported
        });
      }
    })();

    res.json({
      success: true,
      categories_imported: totalCategories,
      channels_imported: totalChannels,
      results
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};
