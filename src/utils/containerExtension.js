const MIME_EXTENSIONS = new Map([
  ['video/mp4', 'mp4'],
  ['video/x-matroska', 'mkv'],
  ['video/mp2t', 'ts'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/aac', 'aac'],
  ['audio/aacp', 'aac'],
  ['application/vnd.apple.mpegurl', 'm3u8'],
  ['application/x-mpegurl', 'm3u8'],
  ['application/dash+xml', 'mpd'],
  ['dash', 'mpd'],
]);

function normalize(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim().toLowerCase();
  const extension = MIME_EXTENSIONS.get(raw) || raw.replace(/^\.+/, '');
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

export function normalizeContainerExtension(value, fallback = 'mp4') {
  return normalize(value) || normalize(fallback) || 'mp4';
}
