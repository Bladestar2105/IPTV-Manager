import dns from 'dns';
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

export function isPrivateIP(ip) {
    const ipVer = isIP(ip);
    if (ipVer === 0) return false;

    if (ipVer === 4) {
        if (ip === '0.0.0.0' ||
            ip.startsWith('127.') ||
            ip.startsWith('10.') ||
            ip.startsWith('192.168.') ||
            ip.startsWith('169.254.') ||
            ip.startsWith('192.0.0.') || // IETF Protocol Assignments
            ip.startsWith('192.0.2.') || // TEST-NET-1
            ip.startsWith('198.51.100.') || // TEST-NET-2
            ip.startsWith('203.0.113.') || // TEST-NET-3
            ip.startsWith('240.')) return true; // Class E (Reserved)

        if (ip.startsWith('172.')) {
            const parts = ip.split('.');
            const second = parseInt(parts[1], 10);
            if (second >= 16 && second <= 31) return true;
        }

        // CGNAT (100.64.0.0/10)
        if (ip.startsWith('100.')) {
            const parts = ip.split('.');
            const second = parseInt(parts[1], 10);
            if (second >= 64 && second <= 127) return true;
        }
    } else if (ipVer === 6) {
         if (ip === '::' || ip === '::1' || ip.includes('::ffff:') || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
    }
    return false;
}

export async function isSafeUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!parsed.protocol.startsWith('http')) return false;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

    // Quick block
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') return false;
    if (hostname === 'metadata.google.internal') return false;

    // Resolve DNS
    const { address } = await dns.promises.lookup(hostname);

    // Check resolved IP
    return !isPrivateIP(address);
  } catch (e) {
    return false;
  }
}

export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    if (isPrivateIP(address)) {
      return callback(new Error(`DNS Lookup resolved to unsafe IP: ${address}`));
    }
    callback(null, address, family);
  });
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

export function getCookie(req, name) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(^| )' + name + '=([^;]+)'));
  if (match) return match[2];
  return null;
}
