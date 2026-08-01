// Shared helpers for Xtream-compatible controllers.

export const sanitizeM3uTag = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, '');
  return str.trim();
};

export const sanitizeM3uName = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf(',') !== -1) str = str.replace(/,/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, '');
  return str.trim();
};

export const sanitizeMetadata = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, "'");
  return str.trim();
};

export const encodeXtreamEpgText = (val) => val ? Buffer.from(String(val)).toString('base64') : '';

export const formatXtreamEpgListing = (program, epgId) => ({
  id: String(program.start),
  epg_id: epgId,
  title: encodeXtreamEpgText(program.title),
  lang: program.lang || '',
  start: program.start_fmt || new Date(Number(program.start) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  end: program.stop_fmt || new Date(Number(program.stop) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  description: encodeXtreamEpgText(program.desc),
  channel_id: epgId,
  start_timestamp: String(program.start),
  stop_timestamp: String(program.stop)
});

export const parseBatchStreamIds = (value) => {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const ids = [];
  const seen = new Set();

  for (const part of raw.split(',')) {
    const id = Number(part.trim());
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 200) break;
  }

  return ids;
};

export const getBatchDateRange = (dateValue) => {
  const raw = Array.isArray(dateValue) ? dateValue[0] : dateValue;
  const date = String(raw || '').trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const startMs = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(startMs)) {
      return {
        start: Math.floor(startMs / 1000),
        end: Math.floor(startMs / 1000) + 86400
      };
    }
  }

  const now = new Date();
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    start: Math.floor(startMs / 1000),
    end: Math.floor(startMs / 1000) + 86400
  };
};

export const getFirstQueryValue = (value) => Array.isArray(value) ? value[0] : value;

export const queryFlagEnabled = (value) => {
  const raw = getFirstQueryValue(value);
  if (raw === undefined || raw === null) return false;
  return ['1', 'true', 'yes', 'on', 'gzip', 'gz'].includes(String(raw).trim().toLowerCase());
};

export const wantsGzipResponse = (req) => {
  if (queryFlagEnabled(req.query.gzip) || queryFlagEnabled(req.query.gz)) return true;
  const format = String(getFirstQueryValue(req.query.format || req.query.output) || '').trim().toLowerCase();
  if (format === 'gz' || format === 'gzip') return true;
  return /\bgzip\b/i.test(String(req.headers?.['accept-encoding'] || ''));
};

export const cppEndpoint = (req, res) => {
  res.json(true);
};

export const streamJsonResponse = (res, stmt, params, mapFn) => {
  res.setHeader('Content-Type', 'application/json');
  res.write('[');
  let isFirst = true;
  let i = 0;
  for (const row of stmt.iterate(...params)) {
    if (!isFirst) res.write(',');
    res.write(JSON.stringify(mapFn(row, i)));
    isFirst = false;
    i++;
  }
  res.write(']');
  res.end();
};

export const getShareScope = (user) => {
  const isShareGuest = !!user?.is_share_guest;
  const allowedChannelIds = isShareGuest
    ? (user.allowed_channels || [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0)
    : null;
  const allowedSet = isShareGuest ? new Set(allowedChannelIds) : null;
  const nowSec = Date.now() / 1000;
  const isExpired = isShareGuest &&
    ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end));

  return { isShareGuest, allowedChannelIds, allowedSet, isExpired };
};

export const appendAllowedChannelFilter = (query, params, allowedChannelIds, column = 'uc.id') => {
  if (!allowedChannelIds) return { query, params };
  if (allowedChannelIds.length === 0) {
    return { query: `${query} AND 1=0`, params };
  }

  const placeholders = allowedChannelIds.map(() => '?').join(',');
  return {
    query: `${query} AND ${column} IN (${placeholders})`,
    params: [...params, ...allowedChannelIds]
  };
};

export const getShareValidityInfo = (user, nowSec) => {
  if (!user?.is_share_guest) return {};

  const validFrom = user.share_start ? Math.floor(user.share_start) : null;
  const validUntil = user.share_end ? Math.floor(user.share_end) : null;
  const isNotYetValid = validFrom !== null && nowSec < validFrom;
  const isExpired = validUntil !== null && nowSec > validUntil;
  const isCurrentlyValid = !isNotYetValid && !isExpired;

  return {
    valid_from: validFrom !== null ? String(validFrom) : null,
    valid_until: validUntil !== null ? String(validUntil) : null,
    is_valid_now: isCurrentlyValid ? 1 : 0
  };
};
