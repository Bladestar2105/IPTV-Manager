import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../database/db.js';
import { decrypt, JWT_SECRET } from '../utils/crypto.js';
import { getSetting } from '../utils/helpers.js';
import { JWT_EXPIRES_IN, BCRYPT_ROUNDS, AUTH_CACHE_TTL, AUTH_CACHE_MAX_SIZE } from '../config/constants.js';

// Authentication Cache
export const authCache = new Map();

// Cleanup interval (every 5 minutes)
setInterval(() => {
  if (authCache.size > AUTH_CACHE_MAX_SIZE) {
    authCache.clear();
    console.log('🧹 Auth Cache cleared (limit reached)');
  } else {
    // Remove expired entries
    const now = Date.now();
    for (const [key, value] of authCache.entries()) {
      if (now > value.expiry) authCache.delete(key);
    }
  }
}, 300000).unref();

export async function authUser(username, password) {
  try {
    const u = (username || '').trim();
    const p = (password || '').trim();
    if (!u || !p) return null;

    // 1. Check Cache
    const cacheKey = crypto.createHash('sha256').update(`${u}:${p}`).digest('hex');
    if (authCache.has(cacheKey)) {
      const cached = authCache.get(cacheKey);
      if (Date.now() < cached.expiry) {
        return cached.user;
      }
      authCache.delete(cacheKey);
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(u);
    if (!user) return null;

    let isValid = false;
    if (user.password && user.password.startsWith('$2b$')) {
        isValid = await bcrypt.compare(p, user.password);
    } else {
        const decrypted = decrypt(user.password);
        isValid = (decrypted === p);
    }

    if (isValid) {
      const { password, otp_secret, ...safeUser } = user;
      authCache.set(cacheKey, {
        user: safeUser,
        expiry: Date.now() + AUTH_CACHE_TTL
      });
      return user;
    }

    return null;
  } catch (e) {
    console.error('authUser error:', e);
    return null;
  }
}

export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      is_active: user.is_active,
      is_admin: user.is_admin,
      role: user.is_admin ? 'admin' : 'user'
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export async function createDefaultAdmin() {
  try {
    const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();

    if (adminCount.count === 0) {
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD;
      let passwordToUse;

      if (initialPassword) {
        passwordToUse = initialPassword;
      } else {
        passwordToUse = crypto.randomBytes(8).toString('hex');
      }

      const username = 'admin';
      const hashedPassword = await bcrypt.hash(passwordToUse, BCRYPT_ROUNDS);

      db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
        .run(username, hashedPassword);

      console.log('\\n' + '='.repeat(60));
      console.log('🔐 DEFAULT ADMIN USER CREATED (WebGUI Only)');
      console.log('='.repeat(60));
      console.log(`Username: ${username}`);
      console.log(`Password: ${passwordToUse}`);
      console.log('='.repeat(60));
      console.log('⚠️  IMPORTANT: Please change this password after first login!');
      console.log('ℹ️  NOTE: Admin user is for WebGUI only, not for IPTV streams!');
      console.log('='.repeat(60) + '\\n');
    }
  } catch (error) {
    console.error('❌ Error creating default admin:', error);
  }
}

export async function getXtreamUser(req) {
  const username = (req.params.username || req.query.username || '').trim();
  const password = (req.params.password || req.query.password || '').trim();
  const token = (req.query.token || '').trim();

  let user = null;

  // Check token auth first (avoids logging failed attempts for placeholder credentials)
  if (token) {
    const now = Math.floor(Date.now() / 1000);
    const valid = db.prepare('SELECT user_id FROM temporary_tokens WHERE token = ? AND expires_at > ?').get(token, now);
    if (valid) {
      user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(valid.user_id);
    }
  }

  // Only try username/password if token auth didn't succeed
  if (!user && username && password) {
    user = await authUser(username, password);
  }

  // Only log failed attempts when there was no token (prevents HLS segment
  // requests with placeholder path params from triggering brute-force protection)
  if (!user && username && !token) {
    const ip = req.ip;
    const now = Math.floor(Date.now() / 1000);

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'xtream_login_failed', `User: ${username}`, now);

    const failWindow = now - 900;
    const failCount = db.prepare(`
      SELECT COUNT(*) as count FROM security_logs
      WHERE ip = ? AND action IN ('login_failed', 'xtream_login_failed') AND timestamp > ?
    `).get(ip, failWindow).count;

    const threshold = parseInt(getSetting(db, 'iptv_block_threshold', '10')) || 10;
    if (failCount >= threshold) {
      const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);

      if (!whitelisted) {
        const durationSetting = getSetting(db, 'iptv_block_duration', '3600');
        const blockDuration = parseInt(durationSetting) || 3600;
        const expiresAt = now + blockDuration;
        db.prepare(`
          INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at
        `).run(ip, 'Too many failed Xtream login attempts', expiresAt);

        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Too many failed Xtream logins (Threshold: ${threshold})`, now);
        console.warn(`⛔ Blocking IP ${ip} due to ${failCount} failed Xtream logins`);
      }
    }
  }

  return user;
}
