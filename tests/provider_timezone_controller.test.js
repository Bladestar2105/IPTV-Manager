import { describe, expect, it, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('fs');
  const os = require('os');
  const path = require('path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(path.join(os.tmpdir(), 'iptv-provider-timezone-')) };
});

vi.mock('../src/config/constants.js', () => ({
  DATA_DIR: TEST_DB_DIR,
  EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
  PORT: 3000,
  BCRYPT_ROUNDS: 1,
  JWT_EXPIRES_IN: '1h',
  AUTH_CACHE_TTL: 60000,
  AUTH_CACHE_MAX_SIZE: 100
}));

vi.mock('../src/utils/network.js', () => ({
  fetchSafe: vi.fn(async () => ({ ok: false }))
}));

vi.mock('../src/utils/helpers.js', async () => {
  const actual = await vi.importActual('../src/utils/helpers.js');
  return { ...actual, isSafeUrl: vi.fn(async () => true) };
});

vi.mock('../src/services/epgService.js', () => ({ updateProviderEpg: vi.fn() }));
vi.mock('../src/services/syncService.js', () => ({
  performSync: vi.fn(),
  checkProviderExpiry: vi.fn(async () => {})
}));
vi.mock('../src/utils/crypto.js', () => ({
  encrypt: value => `enc:${value}`,
  decrypt: value => String(value || '').replace(/^enc:/, ''),
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'test-key-32-bytes-length-12345678'
}));

import db, { initDb } from '../src/database/db.js';
import * as providerController from '../src/controllers/providerController.js';

describe('provider timeshift timezone API', () => {
  beforeEach(() => {
    initDb(true);
    db.pragma('foreign_keys = OFF');
    for (const table of ['providers', 'users', 'admin_users']) db.prepare(`DELETE FROM ${table}`).run();
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO admin_users (id, username, password, is_active) VALUES (1, 'admin', 'x', 1)").run();
    db.prepare("INSERT INTO users (id, username, password, is_active) VALUES (2, 'user', 'x', 1)").run();
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
  const providerBody = (timezone = 'Europe/Berlin') => ({
    name: 'Provider',
    url: 'http://provider.test',
    username: 'user',
    password: 'pass',
    epg_url: 'http://provider.test/epg.xml',
    user_id: 2,
    epg_enabled: false,
    max_connections: 1,
    timeshift_timezone: timezone
  });

  it('accepts and returns a valid provider timezone on create', async () => {
    const res = response();
    await providerController.createProvider({ body: providerBody(), user: { id: 1, is_admin: true } }, res);
    const providerId = res.json.mock.calls[0][0].id;

    expect(db.prepare('SELECT timeshift_timezone FROM providers WHERE id = ?').get(providerId))
      .toEqual({ timeshift_timezone: 'Europe/Berlin' });
    const list = response();
    providerController.getProviders({ query: {}, user: { id: 1, is_admin: true } }, list);
    expect(list.json.mock.calls[0][0][0].timeshift_timezone).toBe('Europe/Berlin');
  });

  it('rejects invalid timezones on create and update', async () => {
    const createRes = response();
    await providerController.createProvider({ body: providerBody('Not/AZone'), user: { id: 1, is_admin: true } }, createRes);
    expect(createRes.status).toHaveBeenCalledWith(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM providers').get().count).toBe(0);

    const providerId = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_enabled, timeshift_timezone)
      VALUES ('Provider', 'http://provider.test', 'user', 'enc:pass', 'http://provider.test/epg.xml', 2, 0, 'UTC')
    `).run().lastInsertRowid;
    const updateRes = response();
    await providerController.updateProvider({
      params: { id: String(providerId) },
      body: providerBody('Not/AZone'),
      user: { id: 1, is_admin: true }
    }, updateRes);
    expect(updateRes.status).toHaveBeenCalledWith(400);
    expect(db.prepare('SELECT timeshift_timezone FROM providers WHERE id = ?').get(providerId))
      .toEqual({ timeshift_timezone: 'UTC' });
  });

  it('updates and clears the optional timezone', async () => {
    const providerId = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_enabled, timeshift_timezone)
      VALUES ('Provider', 'http://provider.test', 'user', 'enc:pass', 'http://provider.test/epg.xml', 2, 0, 'UTC')
    `).run().lastInsertRowid;
    const res = response();
    await providerController.updateProvider({
      params: { id: String(providerId) },
      body: providerBody(''),
      user: { id: 1, is_admin: true }
    }, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(db.prepare('SELECT timeshift_timezone FROM providers WHERE id = ?').get(providerId))
      .toEqual({ timeshift_timezone: null });
  });
});
