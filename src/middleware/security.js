import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import db from '../database/db.js';
import { cleanIp } from '../utils/helpers.js';

function buildSafeRateLimiter(config) {
  return rateLimit({
    ...config,
    // Normalize IPs so IPv4-mapped IPv6 (e.g. ::ffff:1.2.3.4) cannot bypass limits.
    keyGenerator: (req) => ipKeyGenerator(cleanIp(req.ip) || req.ip || 'unknown'),
    validate: { trustProxy: false }
  });
}

// Rate limiting for authentication endpoints
export const authLimiter = buildSafeRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// General API rate limiting
export const apiLimiter = buildSafeRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter rate limiting for client logs (DoS protection)
export const clientLogLimiter = buildSafeRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 log requests per hour
  message: { error: 'Too many log requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "http:", "https:"],
      connectSrc: ["'self'", "http:", "https:"],
      mediaSrc: ["'self'", "blob:", "http:", "https:"],
      workerSrc: ["'self'", "blob:"],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false
});

export const ipBlocker = async (req, res, next) => {
  const ip = req.ip;
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Check Whitelist
    const whitelisted = db.prepare('SELECT id FROM whitelisted_ips WHERE ip = ?').get(ip);
    if (whitelisted) return next();

    // 2. Check Blocklist
    const blocked = db.prepare('SELECT * FROM blocked_ips WHERE ip = ?').get(ip);
    if (blocked) {
      if (blocked.expires_at > now) {
        console.warn(`⛔ IP Blocked: ${ip} (Reason: ${blocked.reason})`);
        return res.status(403).json({ error: 'Access Denied', message: 'Your IP is blocked' });
      } else {
        // Expired, remove it
        db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(blocked.id);
        db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(ip, 'ip_unblocked', 'Block expired', now);
      }
    }
  } catch (e) {
    console.error('IP Check Error:', e);
  }
  next();
};
