import db from '../database/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { BCRYPT_ROUNDS } from '../config/constants.js';

export const getUsers = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const users = db.prepare('SELECT id, username, password, is_active, webui_access, hdhr_enabled, hdhr_token FROM users ORDER BY id').all();
    const result = users.map(u => {
        return {
            id: u.id,
            username: u.username,
            is_active: u.is_active,
            webui_access: u.webui_access,
            hdhr_enabled: u.hdhr_enabled,
            hdhr_token: u.hdhr_token
        };
    });
    res.json(result);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { username, password, webui_access, hdhr_enabled } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Username and password are required'
      });
    }

    const u = username.trim();
    const p = password.trim();

    // Validate username
    if (u.length < 3 || u.length > 50) {
      return res.status(400).json({
        error: 'invalid_username_length',
        message: 'Username must be 3-50 characters'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      return res.status(400).json({
        error: 'invalid_username_format',
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    // Validate password
    if (p.length < 8) {
      return res.status(400).json({
        error: 'password_too_short',
        message: 'Password must be at least 8 characters'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);

    let hdhrToken = null;
    const isHdhrEnabled = hdhr_enabled ? 1 : 0;
    if (isHdhrEnabled) {
        hdhrToken = crypto.randomBytes(16).toString('hex');
    }

    // Insert user
    const info = db.prepare('INSERT INTO users (username, password, webui_access, hdhr_enabled, hdhr_token) VALUES (?, ?, ?, ?, ?)').run(
        u,
        hashedPassword,
        webui_access !== undefined ? (webui_access ? 1 : 0) : 1,
        isHdhrEnabled,
        hdhrToken
    );

    res.json({
      id: info.lastInsertRowid,
      message: 'User created successfully'
    });
  } catch (e) {
    res.status(400).json({error: e.message});
  }
};

export const updateUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { username, password, webui_access, hdhr_enabled } = req.body;

    // Get existing user
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'user not found'});

    const updates = [];
    const params = [];

    if (username) {
        const u = username.trim();
        if (u.length < 3 || u.length > 50) {
            return res.status(400).json({ error: 'invalid_username_length' });
        }
        // Check uniqueness if username changed
        if (u !== existing.username) {
           const duplicate = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
           if (duplicate) return res.status(400).json({ error: 'username_taken' });
        }
        updates.push('username = ?');
        params.push(u);
    }

    if (password) {
        const p = password.trim();
        if (p.length < 8) {
            return res.status(400).json({ error: 'password_too_short' });
        }
        const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);
        updates.push('password = ?');
        params.push(hashedPassword);
    }

    if (webui_access !== undefined) {
        updates.push('webui_access = ?');
        params.push(webui_access ? 1 : 0);
    }

    if (hdhr_enabled !== undefined) {
        const isEnabled = hdhr_enabled ? 1 : 0;
        updates.push('hdhr_enabled = ?');
        params.push(isEnabled);

        if (isEnabled && !existing.hdhr_token) {
            const token = crypto.randomBytes(16).toString('hex');
            updates.push('hdhr_token = ?');
            params.push(token);
        }
    }

    if (updates.length === 0) return res.json({success: true}); // Nothing to update

    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteUser = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);

    db.transaction(() => {
      // 1. Delete owned providers and their dependencies
      const userProviders = db.prepare('SELECT id FROM providers WHERE user_id = ?').all(id);
      for (const p of userProviders) {
        db.prepare('DELETE FROM user_channels WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM stream_stats WHERE channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(p.id);

        db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
      }

      // 2. Delete user data
      db.prepare('DELETE FROM user_channels WHERE user_category_id IN (SELECT id FROM user_categories WHERE user_id = ?)').run(id);

      // Update mappings to remove user_category_id reference before deleting categories
      db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);

      // Delete sync data
      db.prepare('DELETE FROM sync_configs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
