import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcrypt';

const testDataDir = mkdtempSync(join(tmpdir(), 'iptv-password-change-'));
process.env.DATA_DIR = testDataDir;
const { default: db, initDb } = await import('../src/database/db.js');
const { changePassword } = await import('../src/controllers/authController.js');
const { authCache, tokenCache, getXtreamUser } = await import('../src/services/authService.js');
const { encrypt, decrypt } = await import('../src/utils/crypto.js');

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

describe('self-service password changes', () => {
  let userId;
  let username;
  let playerToken;
  let stalkerToken;

  beforeAll(() => initDb(true));
  beforeEach(() => {
    authCache.clear();
    tokenCache.clear();
    username = `password_user_${db.prepare('SELECT COUNT(*) AS count FROM users').get().count}`;
    userId = Number(db.prepare('INSERT INTO users (username, password, plain_password) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync('old-password', 4), encrypt('old-password')).lastInsertRowid);
    playerToken = `player-token-${userId}`;
    stalkerToken = userId.toString(16).padStart(64, '0');
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
      .run(playerToken, userId, expiresAt);
    const deviceId = db.prepare('INSERT INTO stalker_devices (user_id, mac) VALUES (?, ?)')
      .run(userId, `02:00:00:00:00:${userId.toString(16).padStart(2, '0')}`).lastInsertRowid;
    db.prepare('INSERT INTO stalker_sessions (token, device_id, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, 1, ?, 1)')
      .run(stalkerToken, deviceId, userId, expiresAt);
  });

  const authenticate = query => getXtreamUser({ query, params: {}, ip: '127.0.0.1' });
  const change = (isAdmin, oldPassword = 'old-password') => {
    const res = response();
    return changePassword({
      user: { id: userId, is_admin: isAdmin },
      body: { oldPassword, newPassword: 'new-password', confirmPassword: 'new-password' },
      ip: '127.0.0.1'
    }, res).then(() => res);
  };

  it('replaces the saved credentials and revokes previous IPTV authentication', async () => {
    expect(await authenticate({ username, password: 'old-password' })).toMatchObject({ id: userId });
    expect(await authenticate({ token: playerToken })).toMatchObject({ id: userId });
    expect(await authenticate({ token: stalkerToken })).toMatchObject({ id: userId });

    expect((await change(false)).statusCode).toBe(200);

    expect.soft(await authenticate({ username, password: 'old-password' })).toBeNull();
    expect.soft(await authenticate({ token: playerToken })).toBeNull();
    expect.soft(await authenticate({ token: stalkerToken })).toBeNull();
    expect(await authenticate({ username, password: 'new-password' })).toMatchObject({ id: userId });
    const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    expect.soft(decrypt(saved.plain_password)).toBe('new-password');
    expect(saved.plain_password).not.toBe('new-password');
    expect(saved.token_version).toBe(1);
  });

  it('keeps a normal user session when an admin with the same id changes password', async () => {
    db.prepare('INSERT INTO admin_users (id, username, password, force_password_change) VALUES (?, ?, ?, 1)')
      .run(userId, `password_admin_${userId}`, bcrypt.hashSync('old-password', 4));
    expect(await authenticate({ token: playerToken })).toMatchObject({ id: userId });

    expect((await change(true)).statusCode).toBe(200);

    expect(await authenticate({ token: playerToken })).toMatchObject({ id: userId });
    const saved = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(userId);
    expect(bcrypt.compareSync('new-password', saved.password)).toBe(true);
    expect(saved.token_version).toBe(1);
    expect(saved.force_password_change).toBe(0);
  });

  it('preserves credentials and sessions when the old password is incorrect', async () => {
    expect((await change(false, 'wrong-password')).statusCode).toBe(401);
    expect(await authenticate({ username, password: 'old-password' })).toMatchObject({ id: userId });
    expect(await authenticate({ token: playerToken })).toMatchObject({ id: userId });
    expect(await authenticate({ token: stalkerToken })).toMatchObject({ id: userId });
    expect(db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version).toBe(0);
  });
});

afterAll(() => {
  db.close();
  rmSync(testDataDir, { recursive: true, force: true });
});
