// Unknown hosts include provider CDNs: public exceptions must be explicit.
const publicMetadataDomains = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be', 'ytimg.com',
  'imdb.com', 'themoviedb.org', 'tmdb.org', 'thetvdb.com',
];
const sensitiveParameter = /(?:token|password|secret|authorization|api[-_]?key|cookie)|(?:^|[-_])(?:user(?:name)?|pass|key|auth)(?:$|[-_])/i;

export function directMetadataUrl(value, base) {
  if (typeof value !== 'string' || /[|\r\n\u0000]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port) return null;
    if (url.hostname !== 'm.media-amazon.com' && !publicMetadataDomains.some(domain =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    for (const [key, item] of url.searchParams) {
      if (sensitiveParameter.test(key) || /(?:https?:)?\/\//i.test(item)) return null;
    }
    return url.href;
  } catch { return null; }
}
