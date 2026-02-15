import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../utils/crypto.js';
import db from '../database/db.js';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
      // Check DB for user status
      const table = user.is_admin ? 'admin_users' : 'users';
      const dbUser = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(user.id);

      if (!dbUser || !dbUser.is_active) {
        return res.status(401).json({ error: 'User is inactive or deleted' });
      }

      // Check WebUI Access for normal users
      if (!user.is_admin && dbUser.webui_access === 0) {
        return res.status(403).json({ error: 'WebUI access revoked' });
      }

      // Update req.user with fresh data
      req.user = {
        id: dbUser.id,
        username: dbUser.username,
        is_active: dbUser.is_active,
        is_admin: !!user.is_admin,
        otp_enabled: !!dbUser.otp_enabled
      };

      next();
    } catch (e) {
      console.error('Auth Middleware Error:', e);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });
}
