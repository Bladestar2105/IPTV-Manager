import db from '../database/db.js';
import { isIP } from 'net';
import geoip from 'geoip-lite';
import { cleanIp } from '../utils/helpers.js';

export const createClientLog = (req, res) => {
  try {
    const { level, message, stack, user_agent } = req.body;

    // Input Validation & Sanitization
    const allowedLevels = ['info', 'warn', 'error', 'debug'];
    let safeLevel = (level || 'error').toString().toLowerCase();
    if (!allowedLevels.includes(safeLevel)) safeLevel = 'error';

    // Strip HTML tags and limit length
    const stripHtml = (str) => (str || '').toString().replace(/<[^>]*>?/gm, '');

    const safeMessage = stripHtml(message || 'Unknown').substring(0, 500);
    const safeStack = stripHtml(stack || '').substring(0, 1000);
    const safeUserAgent = stripHtml(user_agent || '').substring(0, 200);

    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO client_logs (level, message, stack, user_agent, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(safeLevel, safeMessage, safeStack, safeUserAgent, now);
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getClientLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM client_logs ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const deleteClientLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM client_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getSecurityLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const logs = db.prepare('SELECT * FROM security_logs ORDER BY timestamp DESC LIMIT ?').all(limit);

    // Augment with country code
    const logsWithGeo = logs.map(log => {
      const geo = geoip.lookup(cleanIp(log.ip));
      return { ...log, country: geo && geo.country ? geo.country : null };
    });

    res.json(logsWithGeo);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const deleteSecurityLogs = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    db.prepare('DELETE FROM security_logs').run();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getBlockedIps = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const ips = db.prepare('SELECT * FROM blocked_ips ORDER BY created_at DESC').all();

    // Augment with country code for better admin check
    const ipsWithGeo = ips.map(b => {
      const geo = geoip.lookup(cleanIp(b.ip));
      return { ...b, country: geo && geo.country ? geo.country : null };
    });

    res.json(ipsWithGeo);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const blockIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { ip, reason, duration } = req.body;
    if (!ip || isIP(ip) === 0) return res.status(400).json({error: 'Valid IP required'});

    const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);
    if (whitelisted) {
      return res.status(400).json({error: 'IP is whitelisted. Remove from whitelist first.'});
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (Number(duration) || 3600);

    db.prepare(`
      INSERT INTO blocked_ips (ip, reason, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(ip) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason
    `).run(ip, reason || 'Manual Block', expiresAt);

    db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_blocked', `Manual Block: ${reason || 'No reason'}`, now);

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const unblockIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = req.params.id;
    const now = Math.floor(Date.now() / 1000);
    let ipToLog = id;

    if (id.includes('.') || id.includes(':')) {
       const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(id);
       if (info.changes > 0) {
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(id, 'ip_unblocked', 'Manual Unblock', now);
       }
    } else {
       const entry = db.prepare('SELECT ip FROM blocked_ips WHERE id = ?').get(id);
       if (entry) {
          ipToLog = entry.ip;
          db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(id);
          db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ipToLog, 'ip_unblocked', 'Manual Unblock', now);
       }
    }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getWhitelist = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const ips = db.prepare('SELECT * FROM whitelisted_ips ORDER BY created_at DESC').all();
    res.json(ips);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const whitelistIp = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { ip, description } = req.body;
    if (!ip || isIP(ip) === 0) return res.status(400).json({error: 'Valid IP required'});

    db.prepare('INSERT OR REPLACE INTO whitelisted_ips (ip, description) VALUES (?, ?)').run(ip, description || '');
    const info = db.prepare('DELETE FROM blocked_ips WHERE ip = ?').run(ip);

    if (info.changes > 0) {
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_unblocked', 'Automatically unblocked due to whitelisting', now);
    }

    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const removeWhitelist = (req, res) => {
  try {
     if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
     const id = req.params.id;
     if (id.includes('.') || id.includes(':')) {
        db.prepare('DELETE FROM whitelisted_ips WHERE ip = ?').run(id);
     } else {
        db.prepare('DELETE FROM whitelisted_ips WHERE id = ?').run(id);
     }
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

