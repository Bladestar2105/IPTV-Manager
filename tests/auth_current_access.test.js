import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const dataDir = mkdtempSync(join(tmpdir(), 'iptv-current-access-'));
process.env.DATA_DIR = dataDir;
const { default: db, initDb } = await import('../src/database/db.js');
const { getXtreamUser, authCache, tokenCache, generateToken } = await import('../src/services/authService.js');
const { encrypt } = await import('../src/utils/crypto.js');

const { login } = await import('../src/controllers/authController.js');
const { authenticateToken } = await import('../src/middleware/auth.js');
const { targetUser } = await import('../src/services/ai/context.js');
const { getPreferences } = await import('../src/services/ai/connections.js');
const { accountRow } = await import('../src/services/ai/codex/identity.js');
const app = express();
app.use(express.json());
const { default: epgRoutes } = await import('../src/routes/epg.js');
app.use('/api', epgRoutes);
app.post('/login', login);
app.get('/protected', authenticateToken, (req, res) => res.json({ ok: true }));

describe('current IPTV account and share access', () => {
  let userId;
  const xtreamRequest = query => ({ query, params: {}, ip: '127.0.0.1' });
  const credentials = { username: 'access-user', password: 'access-password' };

  beforeAll(() => initDb(true));
  beforeEach(() => {
    vi.restoreAllMocks();
    authCache.clear();
    tokenCache.clear();
    db.exec('DELETE FROM temporary_tokens; DELETE FROM shared_links; DELETE FROM users; DELETE FROM security_logs; DELETE FROM blocked_ips');
    userId = Number(db.prepare('INSERT INTO users (username,password) VALUES (?,?)')
      .run(credentials.username, encrypt(credentials.password)).lastInsertRowid);
  });
  afterAll(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(['2020-01-01', 1577836800, 1577836800000])('rejects an expired account stored as %s', async expiry => {
    db.prepare('UPDATE users SET expiry_date=? WHERE id=?').run(expiry, userId);
    expect(await getXtreamUser(xtreamRequest(credentials))).toBeNull();
  });

  it.each(['password', 'token'])('rechecks account expiry after a cached %s login', async mode => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE users SET expiry_date=? WHERE id=?').run(now + 3600, userId);
    db.prepare('INSERT INTO temporary_tokens(token,user_id,expires_at) VALUES(?,?,?)').run('access-token', userId, now + 3600);
    const req = xtreamRequest(mode === 'password' ? credentials : { token: 'access-token' });
    expect((await getXtreamUser(req)).id).toBe(userId);
    db.prepare('UPDATE users SET expiry_date=? WHERE id=?').run(now - 1, userId);
    expect(await getXtreamUser(req)).toBeNull();
  });

  it('rejects an account disabled by another worker after caching', async () => {
    const req = xtreamRequest(credentials);
    expect((await getXtreamUser(req)).id).toBe(userId);
    db.prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
    expect(await getXtreamUser(req)).toBeNull();
  });

  it('rejects cached credentials after another worker resets the password', async () => {
    const req = xtreamRequest(credentials);
    expect((await getXtreamUser(req)).id).toBe(userId);
    db.prepare('UPDATE users SET password=?,token_version=token_version+1 WHERE id=?').run(encrypt('new-password'), userId);
    expect(await getXtreamUser(req)).toBeNull();
  });

  it('uses current share channels and rejects a deleted share after caching', async () => {
    db.prepare('INSERT INTO shared_links(token,user_id,channels) VALUES(?,?,?)').run('access-share', userId, '[101]');
    const req = xtreamRequest({ token: 'access-share' });
    expect((await getXtreamUser(req)).allowed_channels).toEqual([101]);
    db.prepare('UPDATE shared_links SET channels=? WHERE token=?').run('[202]', 'access-share');
    expect((await getXtreamUser(req)).allowed_channels).toEqual([202]);
    db.prepare('DELETE FROM shared_links WHERE token=?').run('access-share');
    expect(await getXtreamUser(req)).toBeNull();
  });

  it('never extends a temporary token past its own expiry through caching', async () => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    db.prepare('INSERT INTO temporary_tokens(token,user_id,expires_at) VALUES(?,?,?)').run('short-token', userId, now + 1);
    const req = xtreamRequest({ token: 'short-token' });
    expect((await getXtreamUser(req)).id).toBe(userId);
    Date.now.mockReturnValue((now + 2) * 1000);
    expect(await getXtreamUser(req)).toBeNull();
  });
  it.each(['2020-01-01', 1577836800, 1577836800000])('rejects expired Web UI and AI access stored as %s', async expiry => {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const token = generateToken({ ...user, is_admin: false });
    db.prepare('UPDATE users SET expiry_date=? WHERE id=?').run(expiry, userId);
    expect((await request(app).post('/login').send(credentials)).status).toBe(403);
    expect((await request(app).get('/protected').auth(token, { type: 'bearer' })).status).toBe(403);
    const actor = { id: userId, is_admin: false };
    expect(() => targetUser(actor)).toThrow('AI_FORBIDDEN');
    expect(() => getPreferences(actor)).toThrow(expect.objectContaining({ code: 'AI_FORBIDDEN', status: 403 }));
    expect(accountRow(`user:${userId}`)).toBeNull();
  });

  it.each([
    ["UPDATE users SET expiry_date='2020-01-01' WHERE id=?", 403],
    ['UPDATE users SET is_active=0 WHERE id=?', 401],
    ['UPDATE users SET token_version=token_version+1 WHERE id=?', 401],
  ])('rechecks current JWT access for the player schedule: %s', async (sql, status) => {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const token = generateToken({ ...user, is_admin: false });
    expect((await request(app).get('/api/epg/schedule').auth(token, { type: 'bearer' })).status).toBe(200);
    db.prepare(sql).run(userId);
    expect((await request(app).get('/api/epg/schedule').auth(token, { type: 'bearer' })).status).toBe(status);
  });

  it('keeps current Xtream authentication available for player schedules', async () => {
    expect((await request(app).get('/api/epg/schedule').query(credentials)).status).toBe(200);
    expect((await request(app).get('/api/epg/schedule').query(credentials).set('Authorization', 'Basic legacy-client')).status).toBe(200);
  });

});
