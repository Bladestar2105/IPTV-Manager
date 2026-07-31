export function normalizeMac(value) {
  if (value === null || value === undefined) return null;

  let decoded = Array.isArray(value) ? value[0] : String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }

  const compact = decoded.trim().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(compact)) return null;
  return compact.toUpperCase().match(/.{2}/g).join(':');
}

export function expiryEpoch(value) {
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

export const STALKER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function formatStalkerDateTime(value, timeZone = STALKER_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date).map(part => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
