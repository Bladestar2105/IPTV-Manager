import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('fs');
  const osModule = require('os');
  const pathModule = require('path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-alias-cleanup-')) };
});

vi.mock('../../src/config/constants.js', async (importOriginal) => {
  const path = require('path');
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: TEST_DB_DIR,
    EPG_DB_PATH: path.join(TEST_DB_DIR, 'epg.db'),
    PORT: 3000,
    BCRYPT_ROUNDS: 1,
    JWT_EXPIRES_IN: '1h',
    AUTH_CACHE_TTL: 60000,
    AUTH_CACHE_MAX_SIZE: 100
  };
});

vi.mock('../../src/utils/crypto.js', () => ({
  JWT_SECRET: 'test-secret',
  ENCRYPTION_KEY: 'test-key-32-bytes-length-12345678',
  encrypt: value => value,
  decrypt: value => value,
}));

import db, { initDb } from '../../src/database/db.js';
import { deleteUserCategory } from '../../src/controllers/channelController.js';
import { deleteProvider } from '../../src/controllers/providerController.js';
import { deleteUser } from '../../src/controllers/userController.js';

const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });

describe('series episode alias cascading cleanup', () => {
  beforeAll(() => initDb(true));

  beforeEach(() => {
    db.pragma('foreign_keys = OFF');
    for (const table of [
      'series_episode_aliases', 'provider_series_episodes', 'provider_series_state',
      'user_channels', 'category_mappings', 'epg_channel_mappings', 'stream_stats',
      'provider_channels', 'sync_configs', 'sync_logs', 'provider_icon_cache',
      'providers', 'user_categories', 'temporary_tokens', 'shared_links',
      'user_backups', 'security_logs', 'users'
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.pragma('foreign_keys = ON');
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  const createFixture = () => {
    const userId = db.prepare("INSERT INTO users (username, password) VALUES ('owner', 'password')").run().lastInsertRowid;
    const providerId = db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES ('Provider', 'http://panel.test', 'provider-user', 'provider-pass', ?)
    `).run(userId).lastInsertRowid;
    const providerChannelId = db.prepare(`
      INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
      VALUES (?, 55, 'Series', 'series')
    `).run(providerId).lastInsertRowid;
    const categoryId = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Series', 'series')")
      .run(userId).lastInsertRowid;
    const userChannelId = db.prepare(`
      INSERT INTO user_channels (user_category_id, provider_channel_id)
      VALUES (?, ?)
    `).run(categoryId, providerChannelId).lastInsertRowid;
    const aliasId = db.prepare(`
      INSERT INTO series_episode_aliases
        (user_channel_id, source_key, series_remote_id, remote_episode_id)
      VALUES (?, 'http://panel.test:80', 55, 77)
    `).run(userChannelId).lastInsertRowid;
    return { userId, providerId, categoryId, userChannelId, aliasId };
  };

  const aliasCount = () => db.prepare('SELECT COUNT(*) AS count FROM series_episode_aliases').get().count;

  it('removes aliases when an assignment is permanently deleted', () => {
    const fixture = createFixture();

    db.prepare('DELETE FROM user_channels WHERE id = ?').run(fixture.userChannelId);

    expect(aliasCount()).toBe(0);
  });

  it('removes aliases for every assignment deleted with a category', () => {
    const fixture = createFixture();

    deleteUserCategory({
      params: { id: String(fixture.categoryId) },
      user: { id: 1, is_admin: true, username: 'admin' },
      ip: '127.0.0.1'
    }, response());

    expect(aliasCount()).toBe(0);
  });

  it('removes aliases for assignments deleted with a provider', () => {
    const fixture = createFixture();

    deleteProvider({ user: { is_admin: true }, params: { id: String(fixture.providerId) } }, response());

    expect(aliasCount()).toBe(0);
  });

  it('removes all aliases for a deleted user', () => {
    const fixture = createFixture();

    deleteUser({ user: { is_admin: true }, params: { id: String(fixture.userId) } }, response());

    expect(aliasCount()).toBe(0);
  });
});
