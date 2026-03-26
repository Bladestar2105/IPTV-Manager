import geoip from 'geoip-lite';
import db from '../database/db.js';
import { cleanIp, isUnsafeIP } from '../utils/helpers.js';

/**
 * Checks if the given IP is allowed for the given user based on region locks.
 * @param {string} ip - The IP address of the client.
 * @param {object} user - The user object from the database containing 'allowed_countries'.
 * @returns {boolean} True if allowed, false if blocked.
 */
export function isIpAllowedForUser(ip, user) {
  // If no user or admin, default to allowed (admins don't have region locks via this method yet)
  if (!user || user.is_admin) return true;

  // If no countries are allowed (null or empty string), then no restrictions apply
  if (!user.allowed_countries || user.allowed_countries === 'null' || user.allowed_countries === 'undefined') return true;

  const allowedList = String(user.allowed_countries).split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

  // Empty array after splitting means no restriction
  if (allowedList.length === 0) return true;

  // Check whitelist bypass
  const isWhitelisted = db.prepare('SELECT 1 FROM whitelisted_ips WHERE ip = ?').get(ip);
  if (isWhitelisted) return true;

  const sanitizedIp = cleanIp(ip);

  // Always allow local/private IPs (LAN access)
  if (isUnsafeIP(sanitizedIp)) return true;

  // Resolve IP to country
  const geo = geoip.lookup(sanitizedIp);

  // If IP cannot be resolved, we don't block it (fail-open)
  if (!geo || !geo.country) return true;

  return allowedList.includes(geo.country.toUpperCase());
}
