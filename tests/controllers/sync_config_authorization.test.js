import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
const { memDb } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  return { memDb: new Database(':memory:') };
});
memDb.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
  CREATE TABLE providers (id INTEGER PRIMARY KEY, user_id INTEGER);
  CREATE TABLE sync_configs (
    id INTEGER PRIMARY KEY, provider_id INTEGER UNIQUE, user_id INTEGER,
    enabled INTEGER, sync_interval TEXT, next_sync INTEGER,
    auto_add_categories INTEGER, auto_add_channels INTEGER,
    sync_series_episodes INTEGER, granted_by_admin INTEGER NOT NULL DEFAULT 0
  );
`);

vi.mock('../../src/database/db.js', () => ({ default: memDb }));
vi.mock('../../src/services/syncService.js', () => ({ calculateNextSync: vi.fn(() => 12345) }));
vi.mock('../../src/services/streamManager.js', () => ({ default: {} }));
vi.mock('../../src/utils/crypto.js', () => ({
  encryptWithPassword: vi.fn(),
  decryptWithPassword: vi.fn(),
  decrypt: vi.fn(value => value),
  encrypt: vi.fn(value => value),
}));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn(), loadEpgLogosCache: vi.fn() }));
vi.mock('../../src/services/geoIpUpdateService.js', () => ({
  getGeoIpUpdatePlan: vi.fn(),
  reloadGeoIpData: vi.fn(),
  runGeoIpUpdateProcess: vi.fn(),
}));
vi.mock('systeminformation', () => ({
  default: {
    networkStats: vi.fn().mockResolvedValue([]),
    currentLoad: vi.fn(), cpu: vi.fn(), mem: vi.fn(), fsSize: vi.fn(),
  },
}));

import { createSyncConfig, updateSyncConfig } from '../../src/controllers/systemController.js';

const response = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
});

describe('sync config administrator authorization', () => {
  beforeEach(() => {
    memDb.prepare('DELETE FROM sync_configs').run();
    memDb.prepare('DELETE FROM providers').run();
    memDb.prepare('DELETE FROM users').run();
    memDb.prepare("INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'target')").run();
    memDb.prepare('INSERT INTO providers (id, user_id) VALUES (10, 1)').run();
  });

  it('normalizes a same-owner config to granted_by_admin = 0', () => {
    const req = {
      user: { is_admin: true },
      body: { provider_id: 10, user_id: 1, enabled: true, allow_cross_owner: true },
    };
    const res = response();

    createSyncConfig(req, res);

    expect(res.json).toHaveBeenCalledWith({ id: expect.any(Number) });
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs').get()).toEqual({
      enabled: 1,
      granted_by_admin: 0,
    });
  });

  it('persists an intentional cross-owner administrator grant', () => {
    const req = {
      user: { is_admin: true },
      body: { provider_id: 10, user_id: 2, enabled: true, allow_cross_owner: true },
    };
    const res = response();

    createSyncConfig(req, res);

    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs').get()).toEqual({
      enabled: 1,
      granted_by_admin: 1,
    });
  });

  it('stores a declined cross-owner config disabled and ungranted', () => {
    const req = {
      user: { is_admin: true },
      body: { provider_id: 10, user_id: 2, enabled: true, allow_cross_owner: false },
    };
    const res = response();

    createSyncConfig(req, res);

    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs').get()).toEqual({
      enabled: 0,
      granted_by_admin: 0,
    });
  });

  it('cannot enable an unapproved cross-owner config without explicit approval', () => {
    memDb.prepare(`
      INSERT INTO sync_configs
        (id, provider_id, user_id, enabled, sync_interval, auto_add_categories,
         auto_add_channels, sync_series_episodes, granted_by_admin)
      VALUES (7, 10, 2, 0, 'daily', 1, 1, 1, 0)
    `).run();
    const res = response();

    updateSyncConfig({ user: { is_admin: true }, params: { id: 7 }, body: { enabled: true } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs WHERE id = 7').get()).toEqual({
      enabled: 0,
      granted_by_admin: 0,
    });
  });

  it('can explicitly approve and later revoke a cross-owner config', () => {
    memDb.prepare(`
      INSERT INTO sync_configs
        (id, provider_id, user_id, enabled, sync_interval, auto_add_categories,
         auto_add_channels, sync_series_episodes, granted_by_admin)
      VALUES (7, 10, 2, 0, 'daily', 1, 1, 1, 0)
    `).run();

    updateSyncConfig(
      { user: { is_admin: true }, params: { id: 7 }, body: { enabled: true, allow_cross_owner: true } },
      response()
    );
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs WHERE id = 7').get()).toEqual({
      enabled: 1,
      granted_by_admin: 1,
    });

    updateSyncConfig(
      { user: { is_admin: true }, params: { id: 7 }, body: { allow_cross_owner: false } },
      response()
    );
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs WHERE id = 7').get()).toEqual({
      enabled: 0,
      granted_by_admin: 0,
    });
  });

  it('rejects normal users and missing references', () => {
    const denied = response();
    createSyncConfig({ user: { is_admin: false }, body: { provider_id: 10, user_id: 1 } }, denied);
    expect(denied.status).toHaveBeenCalledWith(403);

    const missing = response();
    createSyncConfig({ user: { is_admin: true }, body: { provider_id: 99, user_id: 1 } }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });

  afterAll(() => memDb.close());
});
