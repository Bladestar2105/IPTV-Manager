import express from 'express';
import db from '../config/database.js';
import { calculateNextSync } from '../utils/helpers.js';
import { startSyncScheduler } from '../services/syncService.js';

const router = express.Router();

// === Sync Config APIs ===
router.get('/sync-configs', (req, res) => {
  try {
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
});

router.get('/sync-configs/:providerId/:userId', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?')
      .get(Number(req.params.providerId), Number(req.params.userId));
    res.json(config || null);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

router.post('/sync-configs', (req, res) => {
  try {
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

    // Restart scheduler
    startSyncScheduler();

    res.json({id: info.lastInsertRowid});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

router.put('/sync-configs/:id', (req, res) => {
  try {
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

    // Restart scheduler
    startSyncScheduler();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

router.delete('/sync-configs/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    db.prepare('DELETE FROM sync_configs WHERE id = ?').run(id);

    // Restart scheduler
    startSyncScheduler();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// === Sync Logs APIs ===
router.get('/sync-logs', (req, res) => {
  try {
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
});

export default router;
