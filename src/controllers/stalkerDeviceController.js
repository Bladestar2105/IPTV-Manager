import db from '../database/db.js';
import { invalidateUserTokens } from '../services/authService.js';
import { normalizeMac } from '../utils/stalker.js';

function requireAdmin(req, res) {
  if (req.user?.is_admin) return true;
  res.status(403).json({ error: 'Access denied' });
  return false;
}

function getUserId(req, res) {
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    res.status(400).json({ error: 'invalid_user_id' });
    return null;
  }
  return userId;
}

function cleanMetadata(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, 100) || null;
}

function constraintResponse(res, error) {
  if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'mac_in_use' });
  }
  return res.status(500).json({ error: error.message });
}

export function getStalkerDevices(req, res) {
  if (!requireAdmin(req, res)) return;
  const userId = getUserId(req, res);
  if (!userId) return;

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  const devices = db.prepare(`
    SELECT id, user_id, mac, enabled, serial_number, device_uid, model,
           last_ip, last_seen, created_at
    FROM stalker_devices
    WHERE user_id = ?
    ORDER BY id
  `).all(userId);

  res.json(devices);
}

export function createStalkerDevice(req, res) {
  if (!requireAdmin(req, res)) return;
  const userId = getUserId(req, res);
  if (!userId) return;

  const mac = normalizeMac(req.body?.mac);
  if (!mac) return res.status(400).json({ error: 'invalid_mac' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  try {
    const info = db.prepare(`
      INSERT INTO stalker_devices (user_id, mac, enabled, serial_number, device_uid, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      mac,
      req.body?.enabled === false ? 0 : 1,
      cleanMetadata(req.body?.serial_number),
      cleanMetadata(req.body?.device_uid),
      cleanMetadata(req.body?.model)
    );

    const device = db.prepare('SELECT * FROM stalker_devices WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(device);
  } catch (error) {
    constraintResponse(res, error);
  }
}

export function updateStalkerDevice(req, res) {
  if (!requireAdmin(req, res)) return;
  const userId = getUserId(req, res);
  if (!userId) return;

  const deviceId = Number(req.params.deviceId);
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'invalid_device_id' });
  }

  const existing = db.prepare('SELECT * FROM stalker_devices WHERE id = ? AND user_id = ?').get(deviceId, userId);
  if (!existing) return res.status(404).json({ error: 'device not found' });

  const updates = [];
  const params = [];

  if (req.body?.mac !== undefined) {
    const mac = normalizeMac(req.body.mac);
    if (!mac) return res.status(400).json({ error: 'invalid_mac' });
    updates.push('mac = ?');
    params.push(mac);
  }
  if (req.body?.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(req.body.enabled ? 1 : 0);
  }

  if (updates.length === 0) return res.json(existing);

  try {
    db.transaction(() => {
      params.push(deviceId);
      db.prepare(`UPDATE stalker_devices SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      db.prepare('DELETE FROM stalker_sessions WHERE device_id = ?').run(deviceId);
    })();
    invalidateUserTokens(userId);
    res.json(db.prepare('SELECT * FROM stalker_devices WHERE id = ?').get(deviceId));
  } catch (error) {
    constraintResponse(res, error);
  }
}

export function deleteStalkerDevice(req, res) {
  if (!requireAdmin(req, res)) return;
  const userId = getUserId(req, res);
  if (!userId) return;

  const deviceId = Number(req.params.deviceId);
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) {
    return res.status(400).json({ error: 'invalid_device_id' });
  }

  const existing = db.prepare('SELECT id FROM stalker_devices WHERE id = ? AND user_id = ?').get(deviceId, userId);
  if (!existing) return res.status(404).json({ error: 'device not found' });

  db.prepare('DELETE FROM stalker_devices WHERE id = ?').run(deviceId);
  invalidateUserTokens(userId);
  res.json({ success: true });
}
