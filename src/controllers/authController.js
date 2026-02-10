import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import db from '../database/db.js';
import { generateToken } from '../services/authService.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { getSetting } from '../utils/helpers.js';
import { JWT_EXPIRES_IN, BCRYPT_ROUNDS } from '../config/constants.js';

export const login = async (req, res) => {
  const ip = req.ip;
  const now = Math.floor(Date.now() / 1000);

  try {
    const { username, password, otp_code } = req.body;

    if (!username || !password) {
      return res.status(400).json({error: 'missing_credentials'});
    }

    // 1. Check admin_users
    let user = db.prepare('SELECT *, 1 as is_admin FROM admin_users WHERE username = ? AND is_active = 1').get(username);
    let table = 'admin_users';

    // 2. Check users if not found in admin
    if (!user) {
        user = db.prepare('SELECT *, 0 as is_admin FROM users WHERE username = ? AND is_active = 1').get(username);
        table = 'users';
    }

    if (user) {
      // Check WebUI Access for normal users
      if (!user.is_admin && user.webui_access === 0) {
          // Log Attempt
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'login_denied', `User: ${username} (WebUI Access Disabled)`, now);
          return res.status(403).json({ error: 'access_denied_webui' });
      }

      // Check Password
      let isValid = false;
      if (user.password && user.password.startsWith('$2b$')) {
          isValid = await bcrypt.compare(password, user.password);
      } else {
          // Legacy/Xtream password (encrypted or plaintext)
          const decrypted = decrypt(user.password);
          isValid = (decrypted === password);
      }

      if (isValid) {
        // Check OTP
        if (user.otp_enabled) {
            if (!otp_code) {
                return res.status(401).json({ error: 'otp_required', require_otp: true });
            }
            // Verify OTP
            const secret = decrypt(user.otp_secret);
            const isValidOtp = authenticator.verify({ token: otp_code, secret: secret });
            if (!isValidOtp) {
                return res.status(401).json({ error: 'invalid_otp' });
            }
        }

        // Convert to boolean for consistency
        user.is_admin = !!user.is_admin;

        const token = generateToken(user);

        // Log Success
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'login_success', `User: ${username} (${table})`, now);

        return res.json({
          token,
          user: {
            id: user.id,
            username: user.username,
            is_active: user.is_active,
            is_admin: user.is_admin,
            otp_enabled: !!user.otp_enabled
          },
          expiresIn: JWT_EXPIRES_IN
        });
      }
    }

    // Log Failure
    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'login_failed', `User: ${username}`, now);

    // Check for brute force
    const failWindow = now - 900; // 15 minutes
    const failCount = db.prepare(`
      SELECT COUNT(*) as count FROM security_logs
      WHERE ip = ? AND action IN ('login_failed', 'xtream_login_failed') AND timestamp > ?
    `).get(ip, failWindow).count;

    const threshold = parseInt(getSetting(db, 'admin_block_threshold', '5')) || 5;
    if (failCount >= threshold) {
      // Check whitelist before blocking
      const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);

      if (!whitelisted) {
        const durationSetting = getSetting(db, 'admin_block_duration', '3600');
        const blockDuration = parseInt(durationSetting) || 3600;
        const expiresAt = now + blockDuration;
        db.prepare(`
          INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at
        `).run(ip, 'Too many failed login attempts', expiresAt);

        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Too many failed WebUI logins (Threshold: ${threshold})`, now);
        console.warn(`⛔ Blocking IP ${ip} due to ${failCount} failed logins`);
      }
    }

    return res.status(401).json({error: 'invalid_credentials'});
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({error: 'server_error'});
  }
};

export const verifyToken = (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
};

export const generateOtp = async (req, res) => {
    try {
        const secret = authenticator.generateSecret();
        const user = req.user;
        const serviceName = 'IPTV-Manager';

        const otpauth = authenticator.keyuri(user.username, serviceName, secret);

        const qrCodeUrl = await QRCode.toDataURL(otpauth);

        // Don't save secret yet, only on verification
        res.json({ secret, qrCodeUrl });
    } catch(e) {
        res.status(500).json({error: e.message});
    }
};

export const verifyOtp = (req, res) => {
    try {
        const { token, secret } = req.body;
        const isValid = authenticator.verify({ token, secret });

        if (!isValid) return res.status(400).json({error: 'invalid_otp'});

        // Save secret and enable OTP
        const table = req.user.is_admin ? 'admin_users' : 'users';
        const encryptedSecret = encrypt(secret);
        db.prepare(`UPDATE ${table} SET otp_secret = ?, otp_enabled = 1 WHERE id = ?`).run(encryptedSecret, req.user.id);

        res.json({success: true});
    } catch(e) {
        res.status(500).json({error: e.message});
    }
};

export const disableOtp = (req, res) => {
    try {
        const table = req.user.is_admin ? 'admin_users' : 'users';
        db.prepare(`UPDATE ${table} SET otp_secret = NULL, otp_enabled = 0 WHERE id = ?`).run(req.user.id);
        res.json({success: true});
    } catch(e) {
        res.status(500).json({error: e.message});
    }
};

export const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.id;
    const isAdmin = req.user.is_admin;

    // Validation
    if (!oldPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({error: 'missing_fields'});
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({error: 'passwords_dont_match'});
    }

    if (newPassword.length < 8) {
      return res.status(400).json({error: 'password_too_short'});
    }

    // Determine table
    const table = isAdmin ? 'admin_users' : 'users';

    // Get user
    const user = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(userId);
    if (!user) {
      return res.status(404).json({error: 'user_not_found'});
    }

    // Verify old password
    let isValidOldPassword = false;
    if (user.password.startsWith('$2b$')) {
        isValidOldPassword = await bcrypt.compare(oldPassword, user.password);
    } else {
        const decrypted = decrypt(user.password);
        isValidOldPassword = (decrypted === oldPassword);
    }

    if (!isValidOldPassword) {
      return res.status(401).json({error: 'invalid_old_password'});
    }

    const newPasswordStored = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Update password
    db.prepare(`UPDATE ${table} SET password = ? WHERE id = ?`).run(newPasswordStored, userId);

    console.log(`✅ Password changed for ${isAdmin ? 'admin' : 'user'}: ${user.username}`);

    res.json({
      success: true,
      message: 'password_changed_successfully'
    });
  } catch (e) {
    console.error('Change password error:', e);
    res.status(500).json({error: 'server_error'});
  }
};

export const createPlayerToken = (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({error: 'user_id required'});

    // Security: Only allow admins to generate tokens for others
    if (!req.user.is_admin && String(req.user.id) !== String(user_id)) {
      console.warn(`⛔ IDOR Attempt: User ${req.user.username} (ID: ${req.user.id}) tried to generate token for ID: ${user_id}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
    if (!user) return res.status(404).json({error: 'User not found'});

    const token = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 21600; // 6 hours

    db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(token, user_id, expiresAt);

    // Cleanup old tokens
    db.prepare('DELETE FROM temporary_tokens WHERE expires_at < ?').run(now);

    res.json({token});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
