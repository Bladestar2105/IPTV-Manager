import { describe, expect, it, beforeAll } from 'vitest';
import db, { initDb } from '../src/database/db.js';
import * as userController from '../src/controllers/userController.js';
import * as providerController from '../src/controllers/providerController.js';
import * as providerCatalogController from '../src/controllers/providerCatalogController.js';
import * as epgMappingController from '../src/controllers/epgMappingController.js';
import * as channelController from '../src/controllers/channelController.js';
import { encrypt } from '../src/utils/crypto.js';

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

describe('per-user upstream provider visibility', () => {
  let userId;
  let providerId;

  beforeAll(() => {
    initDb(true);

    const user = db.prepare(`
      INSERT INTO users (username, password, provider_access)
      VALUES (?, ?, 0)
    `).run(`provider_access_user_${Date.now()}`, 'password');
    userId = Number(user.lastInsertRowid);

    const provider = db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('Visible Provider', 'http://provider.example', 'upstream', encrypt('secret'), userId);
    providerId = Number(provider.lastInsertRowid);

    db.prepare(`
      INSERT INTO provider_channels (provider_id, remote_stream_id, name)
      VALUES (?, ?, ?)
    `).run(providerId, 1, 'Visible Channel');
  });

  it('defaults provider access to disabled', () => {
    const user = db.prepare('SELECT provider_access FROM users WHERE id = ?').get(userId);
    expect(user.provider_access).toBe(0);
  });

  it('returns provider_access in the admin user list', () => {
    const res = response();
    userController.getUsers({ user: { is_admin: true } }, res);

    expect(res.body.find(user => user.id === userId)).toMatchObject({ provider_access: 0 });
  });

  it('lets an admin update provider access for one user', async () => {
    const res = response();
    await userController.updateUser({
      user: { is_admin: true },
      params: { id: userId },
      body: { provider_access: true }
    }, res);

    expect(res.body).toEqual({ success: true });
    expect(db.prepare('SELECT provider_access FROM users WHERE id = ?').get(userId).provider_access).toBe(1);
  });

  it('denies provider list access when provider access is disabled', () => {
    db.prepare('UPDATE users SET provider_access = 0 WHERE id = ?').run(userId);
    const res = response();

    providerController.getProviders({
      user: { id: userId, is_admin: false, provider_access: 0 },
      query: {}
    }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('denies provider channel access when provider access is disabled', () => {
    const res = response();

    providerCatalogController.getProviderChannels({
      user: { id: userId, is_admin: false, provider_access: 0 },
      params: { id: providerId },
      query: {}
    }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('denies provider EPG mapping access when provider access is disabled', () => {
    const res = response();

    epgMappingController.getMappings({
      user: { id: userId, is_admin: false, provider_access: 0 },
      params: { providerId }
    }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('denies provider category mapping access when provider access is disabled', () => {
    const res = response();

    channelController.getCategoryMappings({
      user: { id: userId, is_admin: false, provider_access: 0 },
      params: { providerId, userId }
    }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('returns owned providers after an admin grants access', () => {
    db.prepare('UPDATE users SET provider_access = 1 WHERE id = ?').run(userId);
    const res = response();

    providerController.getProviders({
      user: { id: userId, is_admin: false, provider_access: 1 },
      query: {}
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: providerId, name: 'Visible Provider' })
    ]));
  });
});
