import express from 'express';
import bcrypt from 'bcrypt';
import db from '../config/database.js';
import { authenticateToken, authLimiter } from '../middleware/auth.js';
import dotenv from 'dotenv';

dotenv.config();

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;
const router = express.Router();

// === API: Users ===
router.get('/', authenticateToken, (req, res) => {
  try {
    res.json(db.prepare('SELECT id, username, is_active FROM users ORDER BY id').all());
  } catch (e) { res.status(500).json({error: e.message}); }
});

router.post('/', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

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

    // Insert user
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(u, hashedPassword);

    res.json({
      id: info.lastInsertRowid,
      message: 'User created successfully'
    });
  } catch (e) {
    res.status(400).json({error: e.message});
  }
});

router.delete('/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);

    // Optimized deletion avoiding N+1
    db.prepare('DELETE FROM user_channels WHERE user_category_id IN (SELECT id FROM user_categories WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

export default router;
