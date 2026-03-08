import geoip from 'geoip-lite';
import db from '../database/db.js';

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
  if (!user.allowed_countries) return true;

  const allowedList = user.allowed_countries.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);

  // Empty array after splitting means no restriction
  if (allowedList.length === 0) return true;

  // Check whitelist bypass
  const isWhitelisted = db.prepare('SELECT 1 FROM whitelisted_ips WHERE ip = ?').get(ip);
  if (isWhitelisted) return true;

  // Resolve IP to country
  const geo = geoip.lookup(ip);

  // If IP cannot be resolved, we have to block it because they enabled region lock
  if (!geo || !geo.country) return false;

  return allowedList.includes(geo.country.toUpperCase());
}
