import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn() }));

const { createDefaultAdmin } = await import('../src/services/authService.js');

memDb.exec(`CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT,
  is_active INTEGER, force_password_change INTEGER
);`);

const bootstrap = async () => {
  memDb.prepare('DELETE FROM admin_users').run();
  const lines = [];
  vi.spyOn(console, 'log').mockImplementation(m => lines.push(String(m)));
  await createDefaultAdmin();
  vi.restoreAllMocks();
  return lines.join('\n');
};

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('createDefaultAdmin', () => {
  it('does not echo a password the operator supplied', async () => {
    vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'correct-horse-battery-staple');

    const output = await bootstrap();

    expect(output).not.toContain('correct-horse-battery-staple');
    expect(output).toContain('INITIAL_ADMIN_PASSWORD');
  });

  it('still prints a generated password, which exists nowhere else', async () => {
    vi.stubEnv('INITIAL_ADMIN_PASSWORD', '');

    const output = await bootstrap();

    expect(output).toMatch(/Password: [0-9a-f]{16}/);
  });
});
