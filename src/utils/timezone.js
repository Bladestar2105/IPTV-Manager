const MAX_SUPPORTED_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export function parseTimeshiftTimezone(value) {
  if (value === undefined) return { provided: false, value: null };
  const timezone = String(value ?? '').trim();
  if (!timezone) return { provided: true, value: null };

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    return { provided: true, value: null, error: 'invalid' };
  }
  return { provided: true, value: timezone };
}

export function getRuntimeTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function getEffectiveTimeshiftTimezone(timezone) {
  const parsed = parseTimeshiftTimezone(timezone);
  return parsed.error ? getRuntimeTimezone() : (parsed.value || getRuntimeTimezone());
}

export function formatXtreamTimeshiftStart(epochSeconds, timezone) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0 || epochSeconds > MAX_SUPPORTED_EPOCH_SECONDS) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getEffectiveTimeshiftTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(epochSeconds * 1000));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}:${values.hour}-${values.minute}`;
}

export function isSupportedEpoch(epochSeconds) {
  return Number.isSafeInteger(epochSeconds) && epochSeconds >= 0 && epochSeconds <= MAX_SUPPORTED_EPOCH_SECONDS;
}
