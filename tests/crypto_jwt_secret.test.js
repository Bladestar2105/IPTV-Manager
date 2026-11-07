import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const directories = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../src/config/constants.js');
  vi.resetModules();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function installation(configured, stored) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-signing-key-'));
  directories.push(directory);
  vi.stubEnv('JWT_SECRET', configured);
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.doMock('../src/config/constants.js', () => ({ DATA_DIR: directory }));
  if (stored !== undefined) fs.writeFileSync(path.join(directory, 'jwt.secret'), stored, { mode: 0o600 });
  vi.resetModules();
  return { directory, keys: await import('../src/utils/crypto.js') };
}

test.each([undefined, '', 'your_jwt_secret_here'])('sample signing key is replaced by a persistent private secret (%s)', async stored => {
  const { directory, keys } = await installation('your_jwt_secret_here', stored);
  expect(keys.JWT_SECRET).toMatch(/^[a-f0-9]{64}$/);
  const filename = path.join(directory, 'jwt.secret');
  expect(fs.readFileSync(filename, 'utf8')).toBe(keys.JWT_SECRET);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  expect(() => jwt.verify(jwt.sign({ id: 1 }, 'your_jwt_secret_here'), keys.JWT_SECRET)).toThrow();
  expect(keys.ENCRYPTION_KEY).toBe('a'.repeat(64));
  vi.resetModules();
  expect((await import('../src/utils/crypto.js')).JWT_SECRET).toBe(keys.JWT_SECRET);
});

test('sample configuration preserves an existing unique signing key', async () => {
  const { keys } = await installation('your_jwt_secret_here', 'existing-installation-key');
  expect(keys.JWT_SECRET).toBe('existing-installation-key');
});

test('an explicitly configured private signing key remains unchanged', async () => {
  const { directory, keys } = await installation('custom configured secret', 'existing-installation-key');
  expect(keys.JWT_SECRET).toBe('custom configured secret');
  expect(fs.readFileSync(path.join(directory, 'jwt.secret'), 'utf8')).toBe('existing-installation-key');
});
