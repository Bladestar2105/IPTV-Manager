import { upstreamRequestHeaders } from './clientCookies.js';

// Unknown hosts include provider CDNs: public exceptions must be explicit.
const publicMetadataDomains = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'ytimg.com',
  'imdb.com', 'themoviedb.org', 'tmdb.org', 'thetvdb.com',
];
const sensitiveParameter = /(?:token|password|secret|authorization|api[-_]?key|cookie)|(?:^|[^a-z0-9])(?:user(?:name)?|pass|key|auth)(?:$|[^a-z0-9])/i;
const publicRequestHeaders = new Set(['user-agent', 'accept', 'accept-language', 'accept-encoding']);

function privateUrlData(value) {
  for (let depth = 0; depth <= 8; depth++) {
    if (/(?:https?:)?\/\//i.test(value)) return true;
    for (const [key, item] of new URLSearchParams(value)) {
      if (sensitiveParameter.test(key) || /(?:https?:)?\/\//i.test(item)) return true;
    }
    let decoded;
    try { decoded = decodeURIComponent(value); } catch { return true; }
    if (decoded === value) return false;
    value = decoded;
  }
  return true;
}

export function directMetadataUrl(value, base, requestContext) {
  if (typeof value !== 'string' || /[|\r\n\u0000]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    if (url.hostname !== 'm.media-amazon.com' && !publicMetadataDomains.some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    if ([url.pathname, url.search.slice(1), url.hash.slice(1)].some(privateUrlData)) return null;
    if (requestContext && Object.keys(upstreamRequestHeaders(requestContext, url.href))
      .some(name => !publicRequestHeaders.has(name.toLowerCase()))) return null;
    return url.href;
  } catch { return null; }
}
