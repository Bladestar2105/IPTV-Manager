import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { calculateNextSync } from '../src/services/syncService.js';

describe('calculateNextSync', () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    // Mock time to a fixed timestamp (e.g., 1000000000 * 1000 ms)
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1000000000 * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should calculate hourly interval correctly', () => {
    const nextSync = calculateNextSync('hourly');
    expect(nextSync).toBe(1000000000 + 3600);
  });

  it('should calculate every_6_hours interval correctly', () => {
    const nextSync = calculateNextSync('every_6_hours');
    expect(nextSync).toBe(1000000000 + 21600);
  });

  it('should calculate every_12_hours interval correctly', () => {
    const nextSync = calculateNextSync('every_12_hours');
    expect(nextSync).toBe(1000000000 + 43200);
  });

  it('should calculate daily interval correctly', () => {
    const nextSync = calculateNextSync('daily');
    expect(nextSync).toBe(1000000000 + 86400);
  });

  it('should calculate weekly interval correctly', () => {
    const nextSync = calculateNextSync('weekly');
    expect(nextSync).toBe(1000000000 + 604800);
  });

  it('should default to daily if interval is unknown', () => {
    const nextSync = calculateNextSync('unknown_interval');
    expect(nextSync).toBe(1000000000 + 86400);
  });
});
