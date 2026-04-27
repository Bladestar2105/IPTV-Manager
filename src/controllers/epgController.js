import { clearChannelsCache } from '../services/cacheService.js';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import db from '../database/db.js';
import {
  loadAllEpgChannels,
  updateEpgSource,
  updateProviderEpg,
  deleteEpgSourceData,
  getProgramsNow,
  getProgramsSchedule,
  clearEpgData
} from '../services/epgService.js';
import { getXtreamUser } from '../services/authService.js';
import { ChannelMatcher } from '../services/channelMatcher.js';
import { isSafeUrl } from '../utils/helpers.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../utils/crypto.js';

export const getEpgNow = async (req, res) => {
  try {
    let user = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
       try {
         const token = authHeader.split(' ')[1];
         user = jwt.verify(token, JWT_SECRET);
       } catch(e) {}
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
       } catch(e) {}
    }
    if (!user) {
       user = await getXtreamUser(req);
    }
    if (!user) return res.status(401).json({error: 'Unauthorized'});

    const start = parseInt(req.query.start) || (Math.floor(Date.now() / 1000) - 7200);
    const end = parseInt(req.query.end) || (Math.floor(Date.now() / 1000) + 86400);

    const row = getProgramsSchedule(start, end);
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

    if (!(isSafeUrl(url.trim()))) {
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
      if (!(isSafeUrl(url.trim()))) {
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

export const manualMapping = async (req, res) => {
  try {
    const { provider_channel_id, epg_channel_id } = req.body;
    if (!provider_channel_id || !epg_channel_id) return res.status(400).json({error: 'missing fields'});

    if (!req.user.is_admin) {
        const used = db.prepare(`
            SELECT 1 FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            WHERE uc.provider_channel_id = ? AND cat.user_id = ?
        `).get(Number(provider_channel_id), req.user.id);

        if (!used) return res.status(403).json({error: 'Access denied: Channel not in your categories'});
    }

    db.prepare(`
      INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id)
      VALUES (?, ?)
      ON CONFLICT(provider_channel_id) DO UPDATE SET epg_channel_id = excluded.epg_channel_id
    `).run(Number(provider_channel_id), epg_channel_id);

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(req.ip, 'epg_mapped', `User ${req.user.username} manually mapped EPG channel ${epg_channel_id} to provider channel ${provider_channel_id}`, Math.floor(Date.now() / 1000));

    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteMapping = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.user.is_admin) {
        const used = db.prepare(`
            SELECT 1 FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            WHERE uc.provider_channel_id = ? AND cat.user_id = ?
        `).get(id, req.user.id);

        if (!used) return res.status(403).json({error: 'Access denied: Channel not in your categories'});
    }
    db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id = ?').run(id);

    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getMappings = (req, res) => {
  try {
    const id = Number(req.params.providerId);
    const mappings = db.prepare('SELECT * FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').all(id);
    const map = {};
    mappings.forEach(m => map[m.provider_channel_id] = m.epg_channel_id);
    res.json(map);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const resetMapping = async (req, res) => {
  try {
    const { provider_id, category_id } = req.body;
    if (!provider_id && !category_id) return res.status(400).json({error: 'provider_id or category_id required'});

    if (category_id) {
        if (req.user.is_admin) {
            db.prepare(`
                DELETE FROM epg_channel_mappings
                WHERE provider_channel_id IN (
                    SELECT provider_channel_id
                    FROM user_channels
                    WHERE user_category_id = ?
                )
            `).run(Number(category_id));
        } else {
            db.prepare(`
                DELETE FROM epg_channel_mappings
                WHERE provider_channel_id IN (
                    SELECT uc.provider_channel_id
                    FROM user_channels uc
                    JOIN user_categories cat ON cat.id = uc.user_category_id
                    WHERE uc.user_category_id = ? AND cat.user_id = ?
                )
            `).run(Number(category_id), req.user.id);
        }
    } else {
        if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
        db.prepare(`
            DELETE FROM epg_channel_mappings
            WHERE provider_channel_id IN (
                SELECT id FROM provider_channels WHERE provider_id = ?
            )
        `).run(Number(provider_id));
    }

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(req.ip, 'epg_mapping_reset', `User ${req.user.username} reset EPG mappings`, Math.floor(Date.now() / 1000));

    clearChannelsCache(req.user.id);
    res.json({success: true});
  } catch (e) {
    console.error('Reset mapping error:', e);
    res.status(500).json({error: e.message});
  }
};

export const autoMapping = async (req, res) => {
  try {
    const { provider_id, category_id, only_used } = req.body;
    if (!provider_id && !category_id) return res.status(400).json({error: 'provider_id or category_id required'});

    let channels = [];
    if (category_id) {
        if (req.user.is_admin) {
            channels = db.prepare(`
                SELECT pc.id, pc.name, pc.epg_channel_id
                FROM provider_channels pc
                LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
                WHERE map.id IS NULL AND pc.id IN (
                    SELECT provider_channel_id
                    FROM user_channels
                    WHERE user_category_id = ?
                )
            `).all(Number(category_id));
        } else {
            channels = db.prepare(`
                SELECT pc.id, pc.name, pc.epg_channel_id
                FROM provider_channels pc
                LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
                WHERE map.id IS NULL AND pc.id IN (
                    SELECT uc.provider_channel_id
                    FROM user_channels uc
                    JOIN user_categories cat ON cat.id = uc.user_category_id
                    WHERE uc.user_category_id = ? AND cat.user_id = ?
                )
            `).all(Number(category_id), req.user.id);
        }
    } else {
        if (req.user.is_admin) {
            if (only_used) {
                channels = db.prepare(`
                    SELECT pc.id, pc.name, pc.epg_channel_id
                    FROM provider_channels pc
                    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
                    WHERE map.id IS NULL AND pc.provider_id = ? AND pc.id IN (SELECT provider_channel_id FROM user_channels)
                `).all(Number(provider_id));
            } else {
                channels = db.prepare(`
                    SELECT pc.id, pc.name, pc.epg_channel_id
                    FROM provider_channels pc
                    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
                    WHERE map.id IS NULL AND pc.provider_id = ?
                `).all(Number(provider_id));
            }
        } else {
            channels = db.prepare(`
                SELECT pc.id, pc.name, pc.epg_channel_id
                FROM provider_channels pc
                LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
                WHERE map.id IS NULL AND pc.provider_id = ? AND pc.id IN (
                    SELECT uc.provider_channel_id
                    FROM user_channels uc
                    JOIN user_categories cat ON cat.id = uc.user_category_id
                    WHERE cat.user_id = ?
                )
            `).all(Number(provider_id), req.user.id);
        }
    }

    if (channels.length === 0) return res.json({matched: 0, message: 'No unmapped channels found'});

    const worker = new Worker(path.join(process.cwd(), 'src', 'workers', 'epgWorker.js'), {
      workerData: {
        channels
      }
    });

    const result = await new Promise((resolve, reject) => {
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    });

    if (!result.success) {
      throw new Error(result.error || 'Worker failed');
    }
    if (result.epgEmpty) {
      return res.status(503).json({error: 'EPG data empty. Please update EPG sources.'});
    }

    const { updates, matched } = result;

    if (updates && updates.length > 0) {
      const insert = db.prepare(`
        INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id)
        VALUES (?, ?)
        ON CONFLICT(provider_channel_id) DO UPDATE SET epg_channel_id = excluded.epg_channel_id
      `);

      db.transaction(() => {
        for (const u of updates) {
          insert.run(u.pid, u.eid);
        }
      })();
    }

    if (matched > 0) {
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(req.ip, 'epg_auto_mapped', `User ${req.user.username} auto-mapped ${matched} EPG channels`, Math.floor(Date.now() / 1000));
        clearChannelsCache(req.user.id);
    }

    res.json({success: true, matched});
  } catch (e) {
    console.error('EPG Auto-Map Error:', e);
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


export const suggestMapping = async (req, res) => {
  try {
    const { channel_name, epg_id, limit } = req.body;
    if (!channel_name) return res.status(400).json({error: 'channel_name required'});

    const allEpgChannels = await loadAllEpgChannels();
    const matcher = new ChannelMatcher(allEpgChannels);

    const suggestions = matcher.suggest(channel_name, epg_id || null, limit || 10);

    res.json({ success: true, suggestions });
  } catch (e) {
    console.error('EPG Suggest Error:', e);
    res.status(500).json({error: e.message});
  }
};
