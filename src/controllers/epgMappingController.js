import path from 'path';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import db from '../database/db.js';
import { clearChannelsCache } from '../services/cacheService.js';
import { loadAllEpgChannels } from '../services/epgService.js';
import { ChannelMatcher } from '../services/channelMatcher.js';

const mappingJobs = new Map();
const MAPPING_JOB_TTL_MS = 30 * 60 * 1000;

const httpError = (message, statusCode = 500) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const updateMappingJob = (id, patch) => {
  const job = mappingJobs.get(id) || db.prepare('SELECT * FROM epg_mapping_jobs WHERE id = ?').get(id);
  if (!job) return;
  Object.assign(job, patch, { updated_at: Date.now() });
  saveMappingJob(job);
};

const saveMappingJob = (job) => {
  db.prepare(`
    INSERT INTO epg_mapping_jobs (id, status, progress, matched, message, error, status_code, user_id, created_at, updated_at)
    VALUES (@id, @status, @progress, @matched, @message, @error, @status_code, @user_id, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      progress = excluded.progress,
      matched = excluded.matched,
      message = excluded.message,
      error = excluded.error,
      status_code = excluded.status_code,
      user_id = excluded.user_id,
      updated_at = excluded.updated_at
  `).run({
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    matched: job.matched || 0,
    message: job.message || null,
    error: job.error || null,
    status_code: job.status_code || null,
    user_id: job.user_id || null,
    created_at: job.created_at,
    updated_at: job.updated_at
  });
  mappingJobs.set(job.id, job);
};

const pruneMappingJobs = () => {
  const expiresBefore = Date.now() - MAPPING_JOB_TTL_MS;
  for (const [id, job] of mappingJobs.entries()) {
    if (job.updated_at < expiresBefore) mappingJobs.delete(id);
  }
  db.prepare('DELETE FROM epg_mapping_jobs WHERE updated_at < ?').run(expiresBefore);
};

export const manualMapping = async (req, res) => {
  try {
    const { provider_channel_id, epg_channel_id } = req.body;
    if (!provider_channel_id || !epg_channel_id) return res.status(400).json({error: 'missing fields'});

    if (!req.user.is_admin) {
        const used = db.prepare(`
            SELECT 1 FROM authorized_user_channels uc
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
            SELECT 1 FROM authorized_user_channels uc
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
    if (!req.user.is_admin && !req.user.provider_access) {
      return res.status(403).json({error: 'Access denied'});
    }
    if (!req.user.is_admin) {
      const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(id);
      if (!provider || provider.user_id !== req.user.id) {
        return res.status(403).json({error: 'Access denied'});
      }
    }
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
    const { provider_id, category_id, all_providers } = req.body;

    if (all_providers) {
        if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});

        const result = db.prepare('DELETE FROM epg_channel_mappings').run();
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(req.ip, 'epg_mapping_reset_all', `User ${req.user.username} reset all EPG mappings`, Math.floor(Date.now() / 1000));
        clearChannelsCache();
        return res.json({success: true, reset: result.changes || 0});
    }

    if (!provider_id && !category_id) return res.status(400).json({error: 'provider_id or category_id required'});

    if (category_id) {
        if (req.user.is_admin) {
            db.prepare(`
                DELETE FROM epg_channel_mappings
                WHERE provider_channel_id IN (
                    SELECT provider_channel_id
                    FROM authorized_user_channels
                    WHERE user_category_id = ?
                )
            `).run(Number(category_id));
        } else {
            db.prepare(`
                DELETE FROM epg_channel_mappings
                WHERE provider_channel_id IN (
                    SELECT uc.provider_channel_id
                    FROM authorized_user_channels uc
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

const selectAutoMappingChannels = ({ provider_id, category_id, only_used, all_providers }, user) => {
  let query = `
    SELECT pc.id, pc.name, pc.epg_channel_id, pc.epg_channel_id as epg_id
    FROM provider_channels pc
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE map.id IS NULL
  `;
  const params = [];

  if (all_providers) {
    if (only_used) query += ' AND pc.id IN (SELECT provider_channel_id FROM authorized_user_channels)';
  } else if (category_id) {
    if (user.is_admin) {
      query += `
        AND pc.id IN (
          SELECT provider_channel_id
          FROM authorized_user_channels
          WHERE user_category_id = ?
        )
      `;
      params.push(Number(category_id));
    } else {
      query += `
        AND pc.id IN (
          SELECT uc.provider_channel_id
          FROM authorized_user_channels uc
          JOIN user_categories cat ON cat.id = uc.user_category_id
          WHERE uc.user_category_id = ? AND cat.user_id = ?
        )
      `;
      params.push(Number(category_id), user.id);
    }
  } else if (user.is_admin) {
    query += ' AND pc.provider_id = ?';
    params.push(Number(provider_id));
    if (only_used) query += ' AND pc.id IN (SELECT provider_channel_id FROM authorized_user_channels)';
  } else {
    query += `
      AND pc.provider_id = ?
      AND pc.id IN (
        SELECT uc.provider_channel_id
        FROM authorized_user_channels uc
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ?
      )
    `;
    params.push(Number(provider_id), user.id);
  }

  return db.prepare(query).all(...params);
};

const validateAutoMappingRequest = (body, user) => {
  const { provider_id, category_id, all_providers } = body;
  if (all_providers && !user.is_admin) throw httpError('Access denied', 403);
  if (!all_providers && !provider_id && !category_id) throw httpError('provider_id or category_id required', 400);
};

const runAutoMapping = async ({ body, user, ip, onProgress }) => {
  const { provider_id, category_id, only_used, all_providers } = body;
  validateAutoMappingRequest(body, user);

  onProgress?.(2);
  const channels = selectAutoMappingChannels({ provider_id, category_id, only_used, all_providers }, user);
  onProgress?.(5);

  if (channels.length === 0) {
    onProgress?.(100);
    return {success: true, matched: 0, message: 'No unmapped channels found'};
  }

  const worker = new Worker(path.join(process.cwd(), 'src', 'workers', 'epgWorker.js'), {
    workerData: {
      channels
    }
  });

  const result = await new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message && message.type === 'progress') {
        onProgress?.(message.progress);
        return;
      }
      resolve(message);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
  onProgress?.(85);

  if (!result.success) throw new Error(result.error || 'Worker failed');
  if (result.epgEmpty) throw httpError('EPG data empty. Please update EPG sources.', 503);

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
  onProgress?.(90);

  if (matched > 0) {
    const action = all_providers ? 'epg_auto_mapped_all' : 'epg_auto_mapped';
    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, action, `User ${user.username} auto-mapped ${matched} EPG channels`, Math.floor(Date.now() / 1000));
    clearChannelsCache(all_providers ? undefined : user.id);
  }

  onProgress?.(100);
  return {success: true, matched};
};

const startAutoMappingJob = ({ body, user, ip }) => {
  pruneMappingJobs();
  const id = randomUUID();
  const job = {
    id,
    status: 'running',
    progress: 0,
    matched: 0,
    user_id: user.id,
    created_at: Date.now(),
    updated_at: Date.now()
  };
  saveMappingJob(job);

  runAutoMapping({
    body,
    user,
    ip,
    onProgress: progress => updateMappingJob(id, { progress })
  }).then(result => {
    updateMappingJob(id, {
      status: 'completed',
      progress: 100,
      matched: result.matched || 0,
      message: result.message || null
    });
  }).catch(error => {
    updateMappingJob(id, {
      status: 'failed',
      error: error.message,
      status_code: error.statusCode || 500
    });
  });

  return job;
};

export const getMappingJob = (req, res) => {
  pruneMappingJobs();
  const job = db.prepare('SELECT * FROM epg_mapping_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({error: 'job not found'});
  if (!req.user.is_admin && job.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    matched: job.matched,
    message: job.message,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at
  });
};

export const autoMapping = async (req, res) => {
  try {
    validateAutoMappingRequest(req.body, req.user);

    if (req.body.background) {
      const job = startAutoMappingJob({
        body: { ...req.body },
        user: { ...req.user },
        ip: req.ip
      });
      return res.json({success: true, job_id: job.id, status: job.status, progress: job.progress});
    }

    const result = await runAutoMapping({ body: req.body, user: req.user, ip: req.ip });
    res.json(result);
  } catch (e) {
    if (!e.statusCode || e.statusCode >= 500) console.error('EPG Auto-Map Error:', e);
    res.status(e.statusCode || 500).json({error: e.message});
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
