import { describe, expect, it } from 'vitest';
import {
  formatXtreamTimeshiftStart,
  getEffectiveTimeshiftTimezone,
  getRuntimeTimezone,
  isSupportedEpoch,
  parseTimeshiftTimezone
} from '../src/utils/timezone.js';

describe('provider timeshift timezone handling', () => {
  const winter = Date.parse('2024-01-15T12:00:00Z') / 1000;
  const summer = Date.parse('2024-07-15T12:00:00Z') / 1000;

  it('formats winter and summer epochs using the provider timezone', () => {
    expect(formatXtreamTimeshiftStart(winter, 'Europe/Berlin')).toBe('2024-01-15:13-00');
    expect(formatXtreamTimeshiftStart(summer, 'Europe/Berlin')).toBe('2024-07-15:14-00');
  });

  it('supports UTC and falls back to the runtime timezone when unset', () => {
    expect(formatXtreamTimeshiftStart(winter, 'UTC')).toBe('2024-01-15:12-00');
    expect(getEffectiveTimeshiftTimezone(null)).toBe(getRuntimeTimezone());
    expect(getEffectiveTimeshiftTimezone('')).toBe(getRuntimeTimezone());
  });

  it('validates IANA names and supported epochs', () => {
    expect(parseTimeshiftTimezone('America/New_York')).toEqual({ provided: true, value: 'America/New_York' });
    expect(parseTimeshiftTimezone('')).toEqual({ provided: true, value: null });
    expect(parseTimeshiftTimezone('not/a-timezone').error).toBe('invalid');
    expect(isSupportedEpoch(0)).toBe(true);
    expect(isSupportedEpoch(-1)).toBe(false);
    expect(isSupportedEpoch(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
