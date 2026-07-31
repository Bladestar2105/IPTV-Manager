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

  const addProviderChannel = (ownerId, originalCategoryId = 0) => {
    const providerId = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('P', 'http://provider.example', 'u', 'p', ?)").run(ownerId).lastInsertRowid;
    return db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, stream_type) VALUES (?, 10, 'Show', ?, 'series')").run(providerId, originalCategoryId).lastInsertRowid;
  };

  const addBackup = (data) => db.prepare(`
    INSERT INTO user_backups (user_id, name, timestamp, category_count, channel_count, data)
    VALUES (1, 'snapshot', 1, ?, ?, ?)
  `).run(data.userCategories?.length || 0, data.userChannels?.length || 0, JSON.stringify(data)).lastInsertRowid;

  const restore = (backupId, user = { id: 1, is_admin: false }, body = {}) => {
    const req = { params: { userId: '1', id: String(backupId) }, user, body };
    const res = response();
    restoreBackup(req, res);
    return res;
  };

  it('restores same-owner assignments with IDs preserved and no admin grant', () => {
    const providerChannelId = addProviderChannel(1);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 1 }));

    const res = restore(backupId);

    expect(db.prepare('SELECT id, is_hidden, granted_by_admin, authorization_revoked FROM user_channels').get()).toEqual({
      id: 200, is_hidden: 0, granted_by_admin: 0, authorization_revoked: 0
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, channels_restored: 1, channels_hidden: 0, channels_skipped: 0 });
    expect(clearChannelsCache).toHaveBeenCalledWith(1);
  });

  it('writes a versioned provenance-aware backup payload', () => {
    db.prepare("INSERT INTO user_categories (id, user_id, name, type) VALUES (100, 1, 'Series', 'series')").run();
    const result = response();
    createBackup(
      { params: { userId: '1' }, user: { id: 1, is_admin: false }, body: { name: 'versioned' } },
      result
    );
    const backupId = result.json.mock.calls[0][0].id;
    const payload = JSON.parse(db.prepare('SELECT data FROM user_backups WHERE id = ?').get(backupId).data);
    expect(payload.format_version).toBe(2);
    expect(payload.assignment_provenance_version).toBe(1);
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
    db.prepare('UPDATE user_channels SET granted_by_admin = 0, authorization_revoked = 1 WHERE id = 200').run();

    const res = restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0, granted_by_admin: 0, authorization_revoked: 1
    });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ channels_hidden: 1 }));
  });

  it('keeps a source revocation for a same-owner restore without a valid admin grant', () => {
    const providerChannelId = addProviderChannel(1);
    const backupId = addBackup(backupData(1, {
      provider_channel_id: providerChannelId,
      granted_by_admin: 0,
      authorization_revoked: 1,
    }));

    restore(backupId);

    expect(db.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      granted_by_admin: 0,
      authorization_revoked: 1,
    });
  });

  it('cannot turn crafted cross-owner backup data into an admin grant', () => {
    const providerChannelId = addProviderChannel(2);
    const backupId = addBackup(backupData(1, {
      provider_channel_id: providerChannelId,
      granted_by_admin: 1,
      is_hidden: 0,
    }));

    restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0,
      granted_by_admin: 0,
      authorization_revoked: 1,
    });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toBeUndefined();
  });

  it.each([undefined, false])('keeps an admin-restored cross-owner assignment hidden without explicit approval (%s)', (allowCrossOwner) => {
    const providerChannelId = addProviderChannel(2);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 1 }));
    const body = allowCrossOwner === undefined ? {} : { allow_cross_owner: allowCrossOwner };

    restore(backupId, { id: 9, is_admin: true }, body);

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0,
      granted_by_admin: 0,
      authorization_revoked: 1,
    });
  });

  it('allows an admin to deliberately restore a valid cross-owner assignment', () => {
    const providerChannelId = addProviderChannel(2);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 0 }));

    restore(backupId, { id: 9, is_admin: true }, { allow_cross_owner: true });

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0, granted_by_admin: 1, authorization_revoked: 0
    });
    expect(db.prepare('SELECT id FROM authorized_user_channels WHERE id = 200').get()).toEqual({ id: 200 });
  });

  it('normalizes same-owner assignments restored by an admin to grant zero', () => {
    const providerChannelId = addProviderChannel(1);
    const backupId = addBackup(backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 1 }));

    restore(backupId, { id: 9, is_admin: true });

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0,
      granted_by_admin: 0,
      authorization_revoked: 0,
    });
  });

  it('merges duplicate modern assignments without losing hidden state or names', () => {
    const providerChannelId = addProviderChannel(1);
    db.prepare("INSERT INTO user_categories (id, user_id, name, type) VALUES (100, 1, 'Series', 'series')").run();
    const mappingId = db.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
      SELECT p.id, 1, 10, 'Series', 100, 'series'
      FROM provider_channels pc JOIN providers p ON p.id = pc.provider_id
      WHERE pc.id = ?
    `).run(providerChannelId).lastInsertRowid;
    const data = {
      format_version: 2,
      assignment_provenance_version: 1,
      ...backupData(1, {
        provider_channel_id: providerChannelId,
        assignment_origin: 'manual',
        mapping_id: null,
        sort_order: 9,
        custom_name: '',
        is_hidden: 0,
      }),
    };
    data.categoryMappings = [{
      id: mappingId, user_category_id: 100, provider_category_id: 10,
      category_type: 'series',
    }];
    data.userChannels.push({
      id: 201, user_category_id: 100, provider_channel_id: providerChannelId,
      assignment_origin: 'mapping', mapping_id: mappingId,
      sort_order: 2, custom_name: 'Mapped name', is_hidden: 1,
    });
    const backupId = addBackup(data);

    const res = restore(backupId);

    expect(db.prepare(`
      SELECT id, assignment_origin, mapping_id, sort_order, custom_name, is_hidden
      FROM user_channels
    `).all()).toEqual([{
      id: 200,
      assignment_origin: 'manual',
      mapping_id: null,
      sort_order: 2,
      custom_name: 'Mapped name',
      is_hidden: 1,
    }]);
    expect(res.json).toHaveBeenCalledWith({
      success: true, channels_restored: 0, channels_hidden: 1, channels_skipped: 0,
      channels_merged: 1,
    });
  });

  it('retains a validated modern mapping assignment', () => {
    const providerChannelId = addProviderChannel(1, 10);
    db.prepare("INSERT INTO user_categories (id, user_id, name, type) VALUES (100, 1, 'Series', 'series')").run();
    const mappingId = db.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type)
      SELECT p.id, 1, 10, 'Series', 100, 'series'
      FROM provider_channels pc JOIN providers p ON p.id = pc.provider_id
      WHERE pc.id = ?
    `).run(providerChannelId).lastInsertRowid;
    const data = {
      format_version: 2,
      assignment_provenance_version: 1,
      ...backupData(1, {
        provider_channel_id: providerChannelId,
        assignment_origin: 'mapping', mapping_id: mappingId,
      }),
      categoryMappings: [{ id: mappingId, user_category_id: 100, provider_category_id: 10, category_type: 'series' }],
    };
    const backupId = addBackup(data);

    restore(backupId);

    expect(db.prepare('SELECT assignment_origin, mapping_id FROM user_channels').get()).toEqual({
      assignment_origin: 'mapping', mapping_id: mappingId,
    });
  });

  it.each([
    [[200, 100]],
    [[100, 200]],
  ])('normalizes duplicate backup rows independently of payload order (%s)', (order) => {
    const providerChannelId = addProviderChannel(1);
    const data = backupData(1);
    data.format_version = 2;
    data.assignment_provenance_version = 1;
    data.userChannels = order.map(id => ({
      id,
      user_category_id: 100,
      provider_channel_id: providerChannelId,
      sort_order: id === 100 ? 1 : 4,
      custom_name: id === 100 ? '' : 'Stable name',
      is_hidden: id === 100 ? 0 : 1,
      assignment_origin: id === 100 ? 'mapping' : 'manual',
      mapping_id: null,
    }));
    const backupId = addBackup(data);

    restore(backupId);

    expect(db.prepare(`
      SELECT id, sort_order, custom_name, is_hidden, assignment_origin
      FROM user_channels
    `).get()).toEqual({
      id: 100,
      sort_order: 1,
      custom_name: 'Stable name',
      is_hidden: 1,
      assignment_origin: 'manual'
    });
  });

  it('falls back to the next valid source ID when the lowest ID collides', () => {
    const providerChannelId = addProviderChannel(1);
    db.prepare("INSERT INTO user_categories (id, user_id, name, type) VALUES (900, 2, 'Other', 'series')").run();
    db.prepare(`
      INSERT INTO user_channels (id, user_category_id, provider_channel_id, assignment_origin)
      VALUES (100, 900, ?, 'legacy')
    `).run(providerChannelId);
    const data = backupData(1);
    data.userChannels = [
      { id: 200, user_category_id: 100, provider_channel_id: providerChannelId, assignment_origin: 'legacy' },
      { id: 100, user_category_id: 100, provider_channel_id: providerChannelId, assignment_origin: 'legacy' },
    ];
    const backupId = addBackup(data);

    restore(backupId);

    expect(db.prepare(`
      SELECT id FROM user_channels
      WHERE user_category_id = 100 AND provider_channel_id = ?
    `).get(providerChannelId)).toEqual({ id: 200 });
  });

  it('uses current ownership and skips missing provider channels', () => {
    const providerChannelId = addProviderChannel(1);
    const data = backupData(1, { provider_channel_id: providerChannelId, granted_by_admin: 0 });
    data.userChannels.push({ ...data.userChannels[0], id: 201, provider_channel_id: 9999 });
    const backupId = addBackup(data);
    db.prepare('UPDATE providers SET user_id = 2').run();

    const res = restore(backupId);

    expect(db.prepare('SELECT is_hidden, granted_by_admin, authorization_revoked FROM user_channels WHERE id = 200').get()).toEqual({
      is_hidden: 0, granted_by_admin: 0, authorization_revoked: 1
    });
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
