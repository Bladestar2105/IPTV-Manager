import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'iptv-delete-streams-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = directory;
vi.mock('../../src/services/ai/codex/account.js', () => ({ stopAccountRuntimes: async () => ({ acknowledged: true }) }));
vi.mock('../../src/services/ai/codex/credentials.js', () => ({ purgeIdentity: vi.fn() }));
const { default: db, initDb } = await import('../../src/database/db.js');
const { default: manager } = await import('../../src/services/streamManager.js');
const { deleteUser } = await import('../../src/controllers/userController.js');
let user;
beforeAll(() => { initDb(true); manager.init(db, null); });
beforeEach(() => {
  user = { id: Number(db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`delete-${Date.now()}`, 'pass').lastInsertRowid), username: 'delete-user' };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of manager.localStreams.keys()) await manager.remove(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
});
afterAll(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

it('destroys a real raw stream and removes its ledger row before deleting the user', async () => {
  const resource = { destroyed: false, destroy() { this.destroyed = true; } };
  await manager.reserve('raw-delete', user, 'Live', 'ip', resource, [{ id: 100 }], { dedupe: false });
  const res = response();
  await deleteUser({ user: { is_admin: true }, params: { id: user.id } }, res);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(resource.destroyed).toBe(true);
  expect(db.prepare('SELECT id FROM current_streams').all()).toEqual([]);
  expect(db.prepare('SELECT id FROM users WHERE id = ?').get(user.id)).toBeUndefined();
});

it('cancels an already-authenticated start racing with account deletion', async () => {
  const resource = { destroyed: false, destroy() { this.destroyed = true; } };
  const pending = manager.reserve('racing-start', user, 'Live', 'ip', resource, [{ id: 100 }], { dedupe: false });
  const res = response();
  await deleteUser({ user: { is_admin: true }, params: { id: user.id } }, res);
  expect(res.json).toHaveBeenCalledWith({ success: true });
  expect(await pending).toEqual({ error: 'cancelled' });
  expect(resource.destroyed).toBe(true);
  expect(db.prepare('SELECT id FROM current_streams').all()).toEqual([]);
});

it.each([['is_active', 0], ['token_version', 1], ['expiry_date', '2000-01-01']])('cancels an in-flight start after current %s changes', async (column, value) => {
  const resource = { destroyed: false, destroy() { this.destroyed = true; } };
  const pending = manager.reserve('revoked-start', user, 'Live', 'ip', resource, [{ id: 100 }], { dedupe: false });
  db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(value, user.id);
  expect(await pending).toEqual({ error: 'cancelled' });
  expect(resource.destroyed).toBe(true);
  expect(db.prepare('SELECT id FROM current_streams').all()).toEqual([]);
});

it('validates admin grants against the admin account when a normal account has the same ID', async () => {
  const { createClientResourceUrl, resolveClientResource } = await import('../../src/services/clientResourceService.js');
  db.prepare('INSERT INTO admin_users (id, username, password, token_version) VALUES (?, ?, ?, 7)').run(user.id, `admin-${user.id}`, 'pass');
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(user.id);
  const req = { protocol: 'https', get: () => 'manager.example', app: { get: () => false }, query: {}, params: {} };
  try {
    const url = createClientResourceUrl(req, { id: user.id, is_admin: true, token_version: 7 }, 'https://provider.example/media', { kind: 'resource' });
    const resource = await resolveClientResource({ ...req, params: { data: new URL(url).pathname.split('/')[4] } });
    expect(resource.user.is_admin).toBe(true);
    expect(await manager.reserve('admin-start', resource.user, 'Admin', 'ip', null, [{ id: 100 }], { dedupe: false })).toHaveProperty('provider.id', 100);
    await manager.remove('admin-start');
  } finally { db.prepare('DELETE FROM admin_users WHERE id = ?').run(user.id); }
});

it('rechecks current share scope and preserves its source token through a resolved grant', async () => {
  const { createClientResourceUrl, resolveClientResource } = await import('../../src/services/clientResourceService.js');
  const token = `share-${user.id}`;
  db.prepare('INSERT INTO shared_links (token, user_id, channels) VALUES (?, ?, ?)').run(token, user.id, '[42]');
  const sharedUser = { ...user, is_share_guest: true, resource_token: token, allowed_channels: [42] };
  const resource = { destroyed: false, destroy() { this.destroyed = true; } };
  try {
    const pending = manager.reserve('share-race', sharedUser, 'Share', 'ip', resource, [{ id: 100 }], { dedupe: false, channelId: 42 });
    db.prepare('UPDATE shared_links SET channels = ? WHERE token = ?').run('[43]', token);
    expect(await pending).toEqual({ error: 'cancelled' });
    expect(resource.destroyed).toBe(true);
    db.prepare('UPDATE shared_links SET channels = ? WHERE token = ?').run('[42]', token);
    const req = { protocol: 'https', get: () => 'manager.example', app: { get: () => false }, query: {}, params: {} };
    const url = createClientResourceUrl(req, sharedUser, 'https://provider.example/media', { kind: 'resource' });
    const resolved = await resolveClientResource({ ...req, params: { data: new URL(url).pathname.split('/')[4] } });
    expect(resolved.user.resource_token).toBe(token);
    expect(await manager.reserve('share-valid', resolved.user, 'Share', 'ip', null, [{ id: 100 }], { dedupe: false, channelId: 42 })).toHaveProperty('provider.id', 100);
    await manager.remove('share-valid');
  } finally { db.prepare('DELETE FROM shared_links WHERE token = ?').run(token); }
});

it('keeps the account when a stream owner does not acknowledge termination', async () => {
  await manager.reserve('unreachable-delete', user, 'Live', 'ip', {}, [{ id: 100 }], { dedupe: false });
  vi.spyOn(manager, 'remove').mockResolvedValue(false);
  const res = response();
  await deleteUser({ user: { is_admin: true }, params: { id: user.id } }, res);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id)).toEqual({ is_active: 1 });
  expect(db.prepare('SELECT id FROM current_streams').all()).toEqual([{ id: 'unreachable-delete' }]);
});

it('keeps the account if the stream ledger cannot be read', async () => {
  const original = manager.stmtGetAll;
  manager.stmtGetAll = { all: () => { throw new Error('ledger unavailable'); } };
  const res = response();
  try { await deleteUser({ user: { is_admin: true }, params: { id: user.id } }, res); }
  finally { manager.stmtGetAll = original; }
  expect(res.status).toHaveBeenCalledWith(500);
  expect(db.prepare('SELECT is_active FROM users WHERE id = ?').get(user.id)).toEqual({ is_active: 1 });
});
