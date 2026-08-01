import { clearChannelsCache } from '../services/cacheService.js';
import fs from 'fs';
import path from 'path';
import db from '../database/db.js';
import {
  loadAllEpgChannels,
  updateEpgSource,
  updateProviderEpg,
  deleteEpgSourceData,
  getProgramsNow,
  getProgramsScheduleForChannels,
  clearEpgData
} from '../services/epgService.js';
import { getXtreamUser } from '../services/authService.js';
import { isSafeUrl } from '../utils/helpers.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../utils/crypto.js';
import {
  manualMapping,
  deleteMapping,
  getMappingJob,
  getMappings,
  resetMapping,
  autoMapping,
  suggestMapping
} from './epgMappingController.js';

export {
  manualMapping,
  deleteMapping,
  getMappingJob,
  getMappings,
  resetMapping,
  autoMapping,
  suggestMapping
};

const getUserEpgChannelIds = (user) => {
  let query = `
    SELECT DISTINCT COALESCE(map.epg_channel_id, pc.epg_channel_id) as epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE cat.user_id = ? AND uc.is_hidden = 0
      AND COALESCE(map.epg_channel_id, pc.epg_channel_id, '') != ''
  `;
  let params = [user.id];

  if (user.is_share_guest) {
    const nowSec = Date.now() / 1000;
    if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) {
      return new Set();
    }

    const allowedChannelIds = (user.allowed_channels || [])
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0);

    if (allowedChannelIds.length === 0) return new Set();

    const placeholders = Array(allowedChannelIds.length).fill('?').join(',');
    query += ` AND uc.id IN (${placeholders})`;
    params = params.concat(allowedChannelIds);
  }

  const rows = db.prepare(query).all(...params);
  return new Set(rows.map(row => row.epg_id).filter(Boolean));
};

export const getEpgNow = async (req, res) => {
  try {
    let user = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
       try {
         const token = authHeader.split(' ')[1];
         user = jwt.verify(token, JWT_SECRET);
       } catch {}
    }
    if (!user) {
       user = await getXtreamUser(req);
    }
    if (!user) return res.status(401).json({error: 'Unauthorized'});

    const row = getProgramsNow();
    if (row && row.json_data) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(row.json_data);
    }

    res.json({});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getEpgSchedule = async (req, res) => {
  try {
    let user = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
       try {
         const token = authHeader.split(' ')[1];
         user = jwt.verify(token, JWT_SECRET);
       } catch {}
    }
    if (!user) {
       user = await getXtreamUser(req);
    }
    if (!user) return res.status(401).json({error: 'Unauthorized'});

    const start = parseInt(req.query.start) || (Math.floor(Date.now() / 1000) - 7200);
    const end = parseInt(req.query.end) || (Math.floor(Date.now() / 1000) + 86400);
    const epgChannelIds = getUserEpgChannelIds(user);

    if (epgChannelIds.size === 0) {
      return res.json({});
    }

    const row = getProgramsScheduleForChannels(start, end, epgChannelIds);
    if (row && row.json_data) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(row.json_data);
    }

    res.json({});
  } catch (e) {
    console.error('EPG Schedule error:', e);
    res.status(500).json({error: e.message});
  }
};

export const getEpgSources = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const sources = db.prepare('SELECT * FROM epg_sources ORDER BY name').all();

    const providers = db.prepare("SELECT id, name, epg_url, epg_update_interval, epg_enabled, last_epg_update FROM providers").all();

    const allSources = [
      ...providers.filter(p => p.epg_enabled !== 0).map(p => {
        return {
          id: `provider_${p.id}`,
          name: `${p.name} (Provider EPG)`,
          url: p.epg_url,
          enabled: p.epg_enabled !== 0,
          last_update: p.last_epg_update || 0,
          update_interval: p.epg_update_interval || 86400,
          source_type: 'provider',
          is_updating: 0
        };
      }),
      ...sources
    ];

    res.json(allSources);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const createEpgSource = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { name, url, enabled, update_interval, source_type } = req.body;
    if (!name || !url) return res.status(400).json({error: 'name and url required'});

    if (!(await isSafeUrl(url.trim()))) {
      return res.status(400).json({error: 'invalid_url', message: 'URL is unsafe (blocked)'});
    }

    const info = db.prepare(`
      INSERT INTO epg_sources (name, url, enabled, update_interval, source_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      url.trim(),
      enabled !== undefined ? (enabled ? 1 : 0) : 1,
      update_interval || 86400,
      source_type || 'custom'
    );

    res.json({id: info.lastInsertRowid});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const updateEpgSourceEndpoint = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { name, url, enabled, update_interval } = req.body;

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (url !== undefined) {
      if (!(await isSafeUrl(url.trim()))) {
        return res.status(400).json({error: 'invalid_url', message: 'URL is unsafe (blocked)'});
      }
      updates.push('url = ?');
      params.push(url.trim());
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (update_interval !== undefined) {
      updates.push('update_interval = ?');
      params.push(update_interval);
    }

    if (updates.length === 0) {
      return res.status(400).json({error: 'no fields to update'});
    }

    params.push(id);
    db.prepare(`UPDATE epg_sources SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteEpgSource = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);

    // Delete from epg.db
    deleteEpgSourceData(id, 'custom');

    db.prepare('DELETE FROM epg_sources WHERE id = ?').run(id);
    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const triggerUpdateEpgSource = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = req.params.id;

    if (id.startsWith('provider_')) {
      const providerId = Number(id.replace('provider_', ''));
      await updateProviderEpg(providerId);
      return clearChannelsCache(req.user.id);
    res.json({success: true});
    }

    await updateEpgSource(Number(id));
    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const updateAllEpgSources = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    const providers = db.prepare("SELECT id FROM providers WHERE epg_enabled = 1").all();

    const providerPromises = providers.map(async (provider) => {
      try {
        await updateProviderEpg(provider.id, true);
        return {id: `provider_${provider.id}`, success: true};
      } catch (e) {
        return {id: `provider_${provider.id}`, success: false, error: e.message};
      }
    });

    const sourcePromises = sources.map(async (source) => {
      try {
        await updateEpgSource(source.id, true);
        return {id: source.id, success: true};
      } catch (e) {
        return {id: source.id, success: false, error: e.message};
      }
    });

    const results = await Promise.all([...providerPromises, ...sourcePromises]);

    res.json({success: true, results});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getAvailableEpgSources = async (req, res) => {
  try {
    const jsonPath = path.join(process.cwd(), 'public', 'epg_sources.json');
    if (!fs.existsSync(jsonPath)) {
      return res.json([]);
    }
    const content = await fs.promises.readFile(jsonPath, 'utf8');
    const data = JSON.parse(content);

    const sources = (data.epg_sources || []).map(s => ({
      name: s.name,
      url: s.url,
      size: 0,
      country: s.country_code
    }));

    res.json(sources);
  } catch (e) {
    console.error('EPG sources error:', e.message);
    res.status(500).json({error: e.message});
  }
};

export const getEpgChannels = async (req, res) => {
  try {
    const channels = await loadAllEpgChannels();
    res.json(channels);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const clearEpg = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

    clearEpgData();
    clearChannelsCache(req.user.id);

    res.json({success: true, message: 'EPG data cleared successfully.'});
  } catch (e) {
    console.error('Clear EPG error:', e);
    res.status(500).json({error: e.message});
  }
};

