import express from 'express';
import bcrypt from 'bcrypt';
import db from '../config/database.js';
import { authenticateToken, generateToken, authLimiter, JWT_EXPIRES_IN } from '../middleware/auth.js';
import dotenv from 'dotenv';

dotenv.config();

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 10;
const router = express.Router();

// === API: Authentication ===
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({error: 'missing_credentials'});
    }

    // Check admin_users table for WebGUI login
    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ? AND is_active = 1').get(username);

    if (admin) {
      const isValid = await bcrypt.compare(password, admin.password);
      if (isValid) {
        const token = generateToken(admin, true); // isAdmin = true
        return res.json({
          token,
          user: {
            id: admin.id,
            username: admin.username,
            is_active: admin.is_active,
            is_admin: true
          },
          expiresIn: JWT_EXPIRES_IN
        });
      }
    }

    return res.status(401).json({error: 'invalid_credentials'});
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({error: 'server_error'});
  }
});

// Verify token endpoint
router.get('/verify-token', authenticateToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
});

// Change password endpoint
router.post('/change-password', authenticateToken, authLimiter, async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;

    // Support both 'id' (old token format) and 'userId' (new token format)
    const userId = req.user.userId || req.user.id;

    console.log('Change password request:', {
      userId,
      isAdmin: req.user.isAdmin,
      username: req.user.username
    });

    // Validation
    if (!oldPassword || !newPassword || !confirmPassword) {
      console.error('Missing fields in change password request');
      return res.status(400).json({error: 'missing_fields'});
    }

    if (newPassword !== confirmPassword) {
      console.error('Passwords do not match');
      return res.status(400).json({error: 'passwords_dont_match'});
    }

    if (newPassword.length < 8) {
      console.error('Password too short');
      return res.status(400).json({error: 'password_too_short'});
    }

    // Get admin user - Admins are in admin_users table, NOT users table!
    const admin = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(userId);
    if (!admin) {
      console.error(`Admin user not found with id: ${userId}`);
      return res.status(404).json({error: 'user_not_found'});
    }

    console.log(`Found admin user: ${admin.username}`);

    // Verify old password
    const isValidOldPassword = await bcrypt.compare(oldPassword, admin.password);
    if (!isValidOldPassword) {
      console.error('Invalid old password');
      return res.status(401).json({error: 'invalid_old_password'});
    }

    console.log('Old password verified, updating...');

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Update password
    db.prepare('UPDATE admin_users SET password = ? WHERE id = ?').run(hashedNewPassword, userId);

    console.log(`✅ Password changed for admin: ${admin.username}`);

    res.json({
      success: true,
      message: 'password_changed_successfully'
    });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({error: 'server_error'});
  }
});

export default router;
