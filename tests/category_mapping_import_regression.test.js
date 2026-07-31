import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('fs');
  const os = require('os');
  const path = require('path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(path.join(os.tmpdir(), 'iptv-category-import-')) };
});

vi.mock('../src/config/constants.js', () => ({
  DATA_DIR: TEST_DB_DIR,
  EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
  BCRYPT_ROUNDS: 1,
  DEFAULT_USER_AGENT: 'TestAgent'
}));
vi.mock('../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));
vi.mock('../src/services/epgService.js', () => ({ updateProviderEpg: vi.fn() }));
vi.mock('../src/services/syncService.js', () => ({
  performSync: vi.fn(),
  checkProviderExpiry: vi.fn(async () => {}),
  deleteProviderChannelCascade: vi.fn()
}));
vi.mock('../src/utils/network.js', () => ({ fetchSafe: vi.fn(async () => ({ ok: false })) }));
vi.mock('../src/utils/crypto.js', () => ({
  encrypt: value => String(value || ''),
  decrypt: value => String(value || ''),
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'test-key-32-bytes-length-12345678'
}));

import db, { initDb } from '../src/database/db.js';
import { importCategory, importCategories } from '../src/controllers/providerController.js';

const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });

describe('category import mapping lifecycle', () => {
  beforeAll(() => initDb(true));

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const table of ['user_channels', 'category_mappings', 'provider_channels', 'providers', 'user_categories', 'users']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'user', 'p')").run();
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  const addProvider = () => {
    const providerId = db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES ('Provider', 'http://provider.example', 'u', 'p', 1)
    `).run().lastInsertRowid;
    const channelId = db.prepare(`
      INSERT INTO provider_channels
        (provider_id, remote_stream_id, name, original_category_id, stream_type)
      VALUES (?, 10, 'Channel', 10, 'live')
    `).run(providerId).lastInsertRowid;
    return { providerId: Number(providerId), channelId: Number(channelId) };
  };

  const request = (providerId, body) => ({
    params: { providerId: String(providerId) },
    body,
    user: { id: 1, is_admin: true }
  });

  it('reuses the existing mapped target on repeated single imports', async () => {
    const { providerId } = addProvider();
    const body = { user_id: 1, category_id: 10, category_name: 'News', import_channels: true, type: 'live' };
    const first = response();
    await importCategory(request(providerId, body), first);
    const firstId = first.json.mock.calls[0][0].category_id;
    const second = response();
    await importCategory(request(providerId, body), second);

    expect(second.json.mock.calls[0][0]).toEqual(expect.objectContaining({ category_id: firstId, category_reused: true }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_categories').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM category_mappings').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(1);
    expect(db.prepare('SELECT assignment_origin FROM user_channels').get()).toEqual({ assignment_origin: 'mapping' });
  });

  it('reuses existing targets and merges assignments in repeated bulk imports', async () => {
    const { providerId } = addProvider();
    const body = {
      user_id: 1,
      categories: [{ id: 10, name: 'News', import_channels: true, type: 'live' }]
    };
    const first = response();
    await importCategories(request(providerId, body), first);
    const second = response();
    await importCategories(request(providerId, body), second);

    expect(second.json.mock.calls[0][0]).toEqual(expect.objectContaining({ categories_imported: 1, channels_imported: 0 }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_categories').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(1);
  });

  it('repairs mapping-owned rows stranded outside the current target', async () => {
    const { providerId, channelId } = addProvider();
    const oldCategoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (1, 'Old', 'live')").run().lastInsertRowid;
    const targetCategoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (1, 'News', 'live')").run().lastInsertRowid;
    const mappingId = db.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
      VALUES (?, 1, 10, 'News', ?, 'live')
    `).run(providerId, targetCategoryId).lastInsertRowid;
    db.prepare(`
      INSERT INTO user_channels
        (user_category_id, provider_channel_id, assignment_origin, mapping_id)
      VALUES (?, ?, 'mapping', ?)
    `).run(oldCategoryId, channelId, mappingId);

    const res = response();
    await importCategory(request(providerId, {
      user_id: 1, category_id: 10, category_name: 'News', import_channels: true, type: 'live'
    }), res);

    expect(db.prepare('SELECT user_category_id, assignment_origin, mapping_id FROM user_channels').get()).toEqual({
      user_category_id: Number(targetCategoryId), assignment_origin: 'mapping', mapping_id: Number(mappingId)
    });
  });
});
