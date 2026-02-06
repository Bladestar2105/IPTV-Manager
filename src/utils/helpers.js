import dns from 'dns/promises';
import { isIP } from 'net';

export async function isSafeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!parsed.protocol.startsWith('http')) return false;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // Quick block
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return false;
    if (hostname === 'metadata.google.internal') return false;

    // Resolve DNS
    const { address } = await dns.lookup(hostname);

    // Check resolved IP
    const ipVer = isIP(address);
    if (ipVer === 0) return false;

    if (ipVer === 4) {
        if (address.startsWith('127.') ||
            address.startsWith('10.') ||
            address.startsWith('192.168.') ||
            address.startsWith('169.254.')) return false;

        if (address.startsWith('172.')) {
            const parts = address.split('.');
            const second = parseInt(parts[1], 10);
            if (second >= 16 && second <= 31) return false;
        }
    } else if (ipVer === 6) {
         if (address === '::1' || address.includes('::ffff:') || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return false;
    }

    return true;
  } catch (e) {
    return false;
  }
}

export function isAdultCategory(name) {
  const adultKeywords = [
    '18+', 'adult', 'xxx', 'porn', 'erotic', 'sex', 'nsfw',
    'for adults', 'erwachsene', '+18', '18 plus', 'mature',
    'xxx', 'sexy', 'hot'
  ];
  const nameLower = name.toLowerCase();
  return adultKeywords.some(kw => nameLower.includes(kw));
}

export function getSetting(db, key, defaultValue) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}
