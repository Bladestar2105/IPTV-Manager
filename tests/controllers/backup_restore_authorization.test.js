import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('fs');
  const osModule = require('os');
  const pathModule = require('path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(pathModule.join(osModule.tmpdir(), 'iptv-backup-restore-')) };
});

vi.mock('../../src/config/constants.js', () => ({
  DATA_DIR: TEST_DB_DIR,
  EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
  BCRYPT_ROUNDS: 1,
  DEFAULT_USER_AGENT: 'TestAgent',
}));

vi.mock('../../src/services/cacheService.js', () => ({
  clearChannelsCache: vi.fn(),
}));

import db, { initDb } from '../../src/database/db.js';
import { createBackup, restoreBackup } from '../../src/controllers/backupController.js';
import { clearChannelsCache } from '../../src/services/cacheService.js';

const response = () => ({
  json: vi.fn(),
  status: vi.fn().mockReturnThis(),
});

const backupData = (userId, channel) => ({
  userCategories: [{ id: 100, user_id: userId, name: 'Series', sort_order: 0, is_adult: 0, type: 'series' }],
  userChannels: channel ? [{ id: 200, user_category_id: 100, sort_order: 0, custom_name: '', is_hidden: 0, ...channel }] : [],
  categoryMappings: [],
});

describe('user backup restore authorization', () => {
  beforeAll(() => initDb(true));

  beforeEach(() => {
    vi.clearAllMocks();
    db.pragma('foreign_keys = OFF');
    for (const table of ['user_backups', 'user_channels', 'user_categories', 'provider_channels', 'providers', 'users']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'user', 'p'), (2, 'owner', 'p'), (9, 'admin', 'p')").run();
  });

  afterAll(() => {
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  const addProviderChannel = (ownerId) => {
    const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('P', 'http://provider.example', 'u', 'p', ?)").run(ownerId).lastInsertRowid;
    return db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 10, 'Show', 'series')").run(providerId).lastInsertRowid;
  };

  const addBackup = (data) => db.prepare(`
    INSERT INTO user_backups (user_id, name, timestamp, category_count, channel_count, data)
    VALUES (1, 'snapshot', 1, ?, ?, ?)
  `).run(data.userCategories?.length || 0, data.userChannels?.length || 0, JSON.stringify(data)).lastInsertRowid;

  const restore = (backupId, user = { id: 1, is_admin: false }) => {
    const req = { params: { userId: '1', id: String(backupId) }, user };
    const res = response();
    restoreBackup(req, res);
    return res;
  };

  it('restores same-owner assignments with IDs preserved and no admin grant', () => {
    const providerChannelId = addProviderChannel(1);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 1 }));

    const res = restore(backupId);

    expect(db.prepare('SELECT id, is_hidden, granted_by_admin FROM user_channels').get()).toEqual({ id: 200, is_hidden: 0, granted_by_admin: 0 });
    expect(res.json).toHaveBeenCalledWith({ success: true, channels_restored: 1, channels_hidden: 0, channels_skipped: 0 });
    expect(clearChannelsCache).toHaveBeenCalledWith(1);
  });

  it('does not resurrect a revoked historical admin grant for a normal user', () => {
    const providerChannelId = addProviderChannel(2);
    db.prepare("INSERT INTO user_categories (id, user_id, name, type) VALUES (100, 1, 'Series', 'series')").run();
    db.prepare(`
      INSERT INTO user_channels (id, user_category_id, provider_channel_id, is_hidden, granted_by_admin)
      VALUES (200, 100, ?, 0, 1)
    `).run(providerChannelId);
    const createRes = response();
    createBackup(
      { params: { userId: '1' }, user: { id: 1, is_admin: false }, body: { name: 'active grant' } },
      createRes
    );
    const backupId = createRes.json.mock.calls[0][0].id;

    // Administrator revokes the grant after the snapshot was created.
    db.prepare('UPDATE user_channels SET is_hidden = 1, granted_by_admin = 0 WHERE id = 200').run();

    const res = restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = 200').get()).toEqual({ is_hidden: 1, granted_by_admin: 0 });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ channels_hidden: 1 }));
  });

  it('cannot turn crafted cross-owner backup data into an admin grant', () => {
    const providerChannelId = addProviderChannel(2);
    const backupId = addBackup(backupData(1, {
      provider_channel_id: providerChannelId,
      granted_by_admin: 1,
      is_hidden: 0,
    }));

    restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 1,
      granted_by_admin: 0,
    });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toBeUndefined();
  });

  it('allows an admin to deliberately restore a valid cross-owner assignment', () => {
    const providerChannelId = addProviderChannel(2);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 0 }));

    restore(backupId, { id: 9, is_admin: true });

    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = 200').get()).toEqual({ is_hidden: 0, granted_by_admin: 1 });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toEqual({ id: 200 });
  });

  it('normalizes same-owner assignments restored by an admin to grant zero', () => {
    const providerChannelId = addProviderChannel(1);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 1 }));

    restore(backupId, { id: 9, is_admin: true });

    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0,
      granted_by_admin: 0,
    });
  });

  it('uses current ownership and skips missing provider channels', () => {
    const providerChannelId = addProviderChannel(1);
    const data = backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 0 });
    data.userChannels.push({ ...data.userChannels[0], id: 201, provider_channel_id: 9999 });
    const backupId = addBackup(data);
    db.prepare('UPDATE providers SET user_id = 2').run();

    const res = restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = 200').get()).toEqual({ is_hidden: 1, granted_by_admin: 0 });
    expect(db.prepare('SELECT id FROM user_channels WHERE id = 201').get()).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ channels_hidden: 1, channels_skipped: 1 }));
  });

  it('leaves current data untouched when backup data is malformed', () => {
    db.prepare("INSERT INTO user_categories (id, user_id, name) VALUES (500, 1, 'Current')").run();
    const backupId = addBackup({ userCategories: null, userChannels: [], categoryMappings: [] });

    const res = restore(backupId);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.prepare('SELECT id, name FROM user_categories WHERE id = 500').get()).toEqual({ id: 500, name: 'Current' });
    expect(clearChannelsCache).not.toHaveBeenCalled();
  });

  it('rolls back all restore changes when malformed rows fail inside the transaction', () => {
    db.prepare("INSERT INTO user_categories (id, user_id, name) VALUES (500, 1, 'Current')").run();
    const data = backupData(1);
    data.userCategories.push({ ...data.userCategories[0], name: 'Duplicate ID' });
    const backupId = addBackup(data);

    const res = restore(backupId);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Restore failed' });
    expect(db.prepare('SELECT id, name FROM user_categories WHERE user_id = 1').all()).toEqual([{ id: 500, name: 'Current' }]);
    expect(clearChannelsCache).not.toHaveBeenCalled();
  });
});
