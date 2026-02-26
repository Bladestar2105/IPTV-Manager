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
  getProgramsSchedule
} from '../services/epgService.js';
import { getXtreamUser } from '../services/authService.js';
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

    const programs = getProgramsNow();
    const currentPrograms = {};

    for (const prog of programs) {
        // If multiple sources provide program for same channel, last one wins or handle collision?
        // Since we use channel_id which is XMLTV ID, collisions are possible.
        // We just take one.
        currentPrograms[prog.channel_id] = {
            title: prog.title,
            desc: prog.desc || '',
            start: prog.start,
            stop: prog.stop
        };
    }

    res.json(currentPrograms);
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

    const programs = getProgramsSchedule(start, end);
    const schedule = {};

    for (const prog of programs) {
        if (!schedule[prog.channel_id]) schedule[prog.channel_id] = [];
        schedule[prog.channel_id].push({
          start: prog.start,
          stop: prog.stop,
          title: prog.title,
          desc: prog.desc || ''
        });
    }

    res.json(schedule);
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
      ...providers.map(p => {
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
      return res.json({success: true});
    }

    await updateEpgSource(Number(id));
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

    let query = `DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (`;
    const params = [];

    if (category_id) {
        let subQuery = `SELECT provider_channel_id FROM user_channels uc JOIN user_categories cat ON cat.id = uc.user_category_id WHERE uc.user_category_id = ?`;
        params.push(Number(category_id));
        if (!req.user.is_admin) {
            subQuery += ` AND cat.user_id = ?`;
            params.push(req.user.id);
        }
        query += subQuery;
    } else {
        if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
        query += `SELECT id FROM provider_channels WHERE provider_id = ?`;
        params.push(Number(provider_id));
    }
    query += `)`;

    db.prepare(query).run(...params);

    res.json({success: true});
  } catch (e) {
    console.error('Reset mapping error:', e);
    res.status(500).json({error: e.message});
  }
};

export const applyMapping = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    // Nothing to do as mapping is applied directly in DB
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const autoMapping = async (req, res) => {
  try {
    const { provider_id, category_id, only_used } = req.body;
    if (!provider_id && !category_id) return res.status(400).json({error: 'provider_id or category_id required'});

    let query = `
      SELECT pc.id, pc.name, pc.epg_channel_id
      FROM provider_channels pc
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE map.id IS NULL
    `;
    const params = [];

    if (category_id) {
        query += ` AND pc.id IN (
            SELECT uc.provider_channel_id
            FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            WHERE uc.user_category_id = ?
        `;
        params.push(Number(category_id));
        if (!req.user.is_admin) {
            query += ` AND cat.user_id = ?`;
            params.push(req.user.id);
        }
        query += `)`;
    } else {
        query += ` AND pc.provider_id = ?`;
        params.push(Number(provider_id));

        if (!req.user.is_admin) {
            query += ` AND pc.id IN (
                SELECT uc.provider_channel_id
                FROM user_channels uc
                JOIN user_categories cat ON cat.id = uc.user_category_id
                WHERE cat.user_id = ?
            )`;
            params.push(req.user.id);
        } else if (only_used) {
            query += ` AND pc.id IN (SELECT provider_channel_id FROM user_channels)`;
        }
    }

    const channels = db.prepare(query).all(...params);

    if (channels.length === 0) return res.json({matched: 0, message: 'No unmapped channels found'});

    const globalMappings = db.prepare(`
      SELECT pc.name, map.epg_channel_id
      FROM epg_channel_mappings map
      JOIN provider_channels pc ON pc.id = map.provider_channel_id
    `).all();

    // Load ALL EPG Channels from DB to pass to worker
    const allEpgChannels = await loadAllEpgChannels();

    if (allEpgChannels.length === 0) {
        return res.status(503).json({error: 'EPG data empty. Please update EPG sources.'});
    }

    const worker = new Worker(path.join(process.cwd(), 'src', 'workers', 'epgWorker.js'), {
      workerData: {
        channels,
        allEpgChannels,
        globalMappings
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

    res.json({success: true, matched});
  } catch (e) {
    console.error('EPG Auto-Map Error:', e);
    res.status(500).json({error: e.message});
  }
};
