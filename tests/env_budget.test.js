import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvWarnings, resolveBudget } from '../src/utils/env.js';

// The resolver exists so a misconfigured value never has to be inferred from
// its symptom. That only holds if the line it prints names the actual problem:
// a negative number reported as a unit-suffix problem sends the operator
// looking for a unit that is not there, and an out-of-range warning that echoes
// the re-parsed number quotes a value found nowhere in their configuration.

let warnings;

beforeEach(() => {
  resetEnvWarnings();
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation(message => warnings.push(String(message)));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetEnvWarnings();
});

describe('resolveBudget', () => {
  it('says a negative value is negative', () => {
    expect(resolveBudget('-5', 30000, 1000, 60000, 'SQLITE_BUSY_TIMEOUT_MS')).toBe(30000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/SQLITE_BUSY_TIMEOUT_MS="-5" is negative; using 30000/);
    expect(warnings[0]).not.toMatch(/unit suffix/);
  });

  it('still blames the unit when there is one', () => {
    expect(resolveBudget('30s', 300000, 1000, 600000, 'CATALOG_BODY_TIMEOUT_MS')).toBe(300000);
    expect(warnings[0]).toMatch(/is not a plain integer \(no unit suffixes\); using 300000/);
  });

  it('quotes what the operator typed when clamping, and names the range', () => {
    // Number.parseInt('99999999999999999999') is 1e20, which prints as
    // 100000000000000000000 — a value nobody wrote.
    expect(resolveBudget('99999999999999999999', 67108864, 1048576, 268435456, 'SQLITE_WAL_SIZE_LIMIT_BYTES'))
      .toBe(268435456);
    expect(warnings[0]).toContain('"99999999999999999999"');
    expect(warnings[0]).toContain('(1048576–268435456)');
    expect(warnings[0]).not.toContain('100000000000000000000');
  });

  it('reports zero as not positive', () => {
    expect(resolveBudget('0', 120000, 1000, 600000, 'STREAM_MAX_AGE_MS')).toBe(120000);
    expect(warnings[0]).toMatch(/STREAM_MAX_AGE_MS="0" is not a positive integer/);
  });

  it('warns once per value, however hot the path', () => {
    for (let i = 0; i < 50; i++) resolveBudget('30s', 1000, 1, 2000, 'HTTP_MAX_REQUEST_MS');
    expect(warnings).toHaveLength(1);
  });

  it('is silent for an absent or usable value', () => {
    expect(resolveBudget(undefined, 42, 1, 100, 'X')).toBe(42);
    expect(resolveBudget('  7  ', 42, 1, 100, 'X')).toBe(7);
    expect(warnings).toEqual([]);
  });
});
