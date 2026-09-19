import { afterEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';

// `parseInt(process.env.BCRYPT_ROUNDS) || 10` reads the typo `1O` — capital O
// for zero — as 1, and bcrypt silently rewrites anything below 4 to 4. A cost
// factor of 10 becomes a cost factor of 4, sixty-four times cheaper to brute
// force, with nothing in the log, nothing in the configuration and nothing in
// the hash format to distinguish it from a deliberate choice.

const constant = async (name, raw) => {
  vi.resetModules();
  vi.stubEnv(name, raw);
  return (await import('../src/config/constants.js'))[name];
};
const rounds = raw => constant('BCRYPT_ROUNDS', raw);

const cost = value => bcrypt.hashSync('x', value).slice(0, 7);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('BCRYPT_ROUNDS', () => {
  it('refuses a typo instead of quietly hashing at cost 4', async () => {
    expect(await rounds('1O')).toBe(10);
    expect(cost(await rounds('1O'))).toBe('$2b$10$');
  });

  it('refuses a negative value, which makes bcrypt reject every salt', async () => {
    expect(() => bcrypt.hashSync('x', -1)).toThrow(/salt/i);
    expect(await rounds('-1')).toBe(10);
  });

  it('honours a value meant literally', async () => {
    expect(await rounds('12')).toBe(12);
  });

  it('clamps to the ceiling bcrypt itself enforces', async () => {
    expect(await rounds('99')).toBe(31);
  });

  it('falls back to the default when unset', async () => {
    expect(await rounds('')).toBe(10);
  });
});

describe('PORT', () => {
  it('refuses a value app.listen would read as a pipe path', async () => {
    // `app.listen('3000x')` opens a unix socket named 3000x in the working
    // directory, prints the usual listening line, and is reachable by nothing.
    expect(await constant('PORT', '3000x')).toBe(3000);
  });

  it('honours a port meant literally and clamps past the protocol ceiling', async () => {
    expect(await constant('PORT', '8080')).toBe(8080);
    expect(await constant('PORT', '70000')).toBe(65535);
  });
});
