import db from '../database/db.js';
import { calculateNextSync } from '../services/syncService.js';
import { resolveAssignmentGrant } from '../utils/helpers.js';

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
    const { provider_id, user_id, enabled, sync_interval, auto_add_categories, auto_add_channels, sync_series_episodes, allow_cross_owner } = req.body;

    if (!provider_id || !user_id) {
      return res.status(400).json({error: 'provider_id and user_id required'});
    }

    const providerId = Number(provider_id);
    const userId = Number(user_id);
    const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
    if (!provider) return res.status(404).json({error: 'Provider not found'});
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
      return res.status(404).json({error: 'User not found'});
    }

    const grantedByAdmin = resolveAssignmentGrant({
      categoryOwnerId: userId,
      providerOwnerId: provider.user_id,
      isAdmin: true,
      allowExplicitAdminGrant: allow_cross_owner === true
    });
    if (grantedByAdmin === null) {
      return res.status(400).json({error: 'allow_cross_owner=true is required for a cross-owner sync config'});
    }

    const nextSync = calculateNextSync(sync_interval || 'daily');

    const info = db.prepare(`
      INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, next_sync, auto_add_categories, auto_add_channels, sync_series_episodes, granted_by_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      providerId,
      userId,
      enabled ? 1 : 0,
      sync_interval || 'daily',
      nextSync,
      auto_add_categories ? 1 : 0,
      auto_add_channels ? 1 : 0,
      sync_series_episodes === undefined ? 1 : (sync_series_episodes ? 1 : 0),
      grantedByAdmin === 1 ? 1 : 0
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
    const { enabled, sync_interval, auto_add_categories, auto_add_channels, sync_series_episodes, allow_cross_owner } = req.body;

    const config = db.prepare(`
      SELECT sc.*, p.user_id AS provider_owner_id
      FROM sync_configs sc
      JOIN providers p ON p.id = sc.provider_id
      WHERE sc.id = ?
    `).get(id);
    if (!config) return res.status(404).json({error: 'not found'});
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(config.user_id)) {
      return res.status(404).json({error: 'User not found'});
    }

    let allowExplicitAdminGrant = Number(config.granted_by_admin) === 1;
    if (allow_cross_owner === true) allowExplicitAdminGrant = true;
    if (allow_cross_owner === false) allowExplicitAdminGrant = false;
    const grantedByAdmin = resolveAssignmentGrant({
      categoryOwnerId: config.user_id,
      providerOwnerId: config.provider_owner_id,
      isAdmin: true,
      allowExplicitAdminGrant
    });

    let nextEnabled = enabled !== undefined ? (enabled ? 1 : 0) : config.enabled;
    if (allow_cross_owner === false && grantedByAdmin === null) nextEnabled = 0;
    if (grantedByAdmin === null && nextEnabled === 1) {
      return res.status(400).json({error: 'Cross-owner sync requires explicit admin approval'});
    }

    const nextSync = calculateNextSync(sync_interval || config.sync_interval);

    db.prepare(`
      UPDATE sync_configs
      SET enabled = ?, sync_interval = ?, next_sync = ?, auto_add_categories = ?, auto_add_channels = ?, sync_series_episodes = ?, granted_by_admin = ?
      WHERE id = ?
    `).run(
      nextEnabled,
      sync_interval || config.sync_interval,
      nextSync,
      auto_add_categories !== undefined ? (auto_add_categories ? 1 : 0) : config.auto_add_categories,
      auto_add_channels !== undefined ? (auto_add_channels ? 1 : 0) : config.auto_add_channels,
      sync_series_episodes !== undefined ? (sync_series_episodes ? 1 : 0) : (config.sync_series_episodes === undefined || config.sync_series_episodes === null ? 1 : config.sync_series_episodes),
      grantedByAdmin === 1 ? 1 : 0,
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

