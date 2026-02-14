import dns from 'dns/promises';
import { isIP } from 'net';

export function getBaseUrl(req) {
  const protocol = req.protocol;
  let host = req.get('host');

  // Respect X-Forwarded-Host if trust proxy is enabled
  const trustProxy = req.app.get('trust proxy');
  const xfh = req.get('x-forwarded-host');

  if (trustProxy && xfh) {
      host = xfh.split(',')[0].trim();
  }

  return `${protocol}://${host}`;
}

export function isSafeIP(address) {
  const ipVer = isIP(address);
  if (ipVer === 0) return false;

  if (ipVer === 4) {
      if (address === '0.0.0.0' ||
          address.startsWith('127.') ||
          address.startsWith('10.') ||
          address.startsWith('192.168.') ||
          address.startsWith('169.254.') ||
          address.startsWith('192.0.0.') || // IETF Protocol Assignments
          address.startsWith('192.0.2.') || // TEST-NET-1
          address.startsWith('198.51.100.') || // TEST-NET-2
          address.startsWith('203.0.113.') || // TEST-NET-3
          address.startsWith('240.')) return false; // Class E (Reserved)

      // Class D (Multicast) 224.0.0.0 - 239.255.255.255
      const firstOctet = parseInt(address.split('.')[0], 10);
      if (firstOctet >= 224 && firstOctet <= 239) return false;

      // 172.16.0.0 - 172.31.255.255
      if (address.startsWith('172.')) {
          const parts = address.split('.');
          const second = parseInt(parts[1], 10);
          if (second >= 16 && second <= 31) return false;
      }

      // CGNAT (100.64.0.0/10)
      if (address.startsWith('100.')) {
          const parts = address.split('.');
          const second = parseInt(parts[1], 10);
          if (second >= 64 && second <= 127) return false;
      }
  } else if (ipVer === 6) {
       if (address === '::' || address === '::1' || address.includes('::ffff:') || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return false;
  }
  return true;
}

export async function isSafeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!parsed.protocol.startsWith('http')) return false;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // Quick block known unsafe hostnames
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return false;
    if (hostname === 'metadata.google.internal') return false;

    // Resolve DNS
    const { address } = await dns.lookup(hostname);

    return isSafeIP(address);
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
