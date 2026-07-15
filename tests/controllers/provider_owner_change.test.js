import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEST_DB_DIR = path.join(process.cwd(), 'tests/temp_db_provider_owner');
fs.mkdirSync(TEST_DB_DIR, { recursive: true });

vi.mock('../../src/config/constants.js', () => {
  const pathModule = require('path');
  return {
    DATA_DIR: pathModule.join(process.cwd(), 'tests/temp_db_provider_owner'),
    EPG_DB_PATH: pathModule.join(process.cwd(), 'tests/temp_db_provider_owner/epg.db'),
    BCRYPT_ROUNDS: 1,
    DEFAULT_USER_AGENT: 'TestAgent',
  };
});

vi.mock('../../src/utils/crypto.js', () => ({
  encrypt: vi.fn((value) => `enc:${value}`),
  decrypt: vi.fn((value) => String(value || '').replace(/^enc:/, '')),
}));

vi.mock('../../src/utils/network.js', () => ({ fetchSafe: vi.fn() }));
vi.mock('../../src/services/syncService.js', () => ({
  performSync: vi.fn(),
  checkProviderExpiry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/epgService.js', () => ({
  updateProviderEpg: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/cacheService.js', () => ({
  clearChannelsCache: vi.fn(),
}));

import db, { initDb } from '../../src/database/db.js';
import { updateProvider } from '../../src/controllers/providerController.js';
import { clearChannelsCache } from '../../src/services/cacheService.js';

describe('provider owner changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initDb(true);
    db.pragma('foreign_keys = OFF');
    for (const table of ['security_logs', 'user_channels', 'user_categories', 'provider_channels', 'providers', 'users']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.pragma('foreign_keys = ON');
  });

  it('hides newly invalid normal assignments but preserves explicit admin grants', async () => {
    db.prepare("INSERT INTO users (id, username, password) VALUES (1, 'old-owner', 'p'), (2, 'new-owner', 'p'), (3, 'shared-user', 'p')").run();
    const providerId = db.prepare(`
      INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_enabled, max_connections)
      VALUES ('Provider', 'http://provider.example', 'upstream', 'enc:secret', 'http://epg.example/xmltv', 1, 0, 5)
    `).run().lastInsertRowid;
    const providerChannelId = db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, 10, 'Channel', 'live')").run(providerId).lastInsertRowid;
    const oldCategoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (1, 'Old')").run().lastInsertRowid;
    const newCategoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (2, 'New')").run().lastInsertRowid;
    const sharedCategoryId = db.prepare("INSERT INTO user_categories (user_id, name) VALUES (3, 'Shared')").run().lastInsertRowid;

    const oldAssignmentId = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 0)').run(oldCategoryId, providerChannelId).lastInsertRowid;
    const newAssignmentId = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 0)').run(newCategoryId, providerChannelId).lastInsertRowid;
    const grantedAssignmentId = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin) VALUES (?, ?, 1)').run(sharedCategoryId, providerChannelId).lastInsertRowid;

    const req = {
      params: { id: String(providerId) },
      body: {
        name: 'Provider',
        url: 'http://provider.example',
        username: 'upstream',
        password: '********',
        epg_url: 'http://epg.example/xmltv',
        user_id: 2,
        epg_enabled: false,
        max_connections: 5,
      },
      user: { id: 99, username: 'admin', is_admin: true },
      ip: '127.0.0.1',
    };
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

    await updateProvider(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId).user_id).toBe(2);
    expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(oldAssignmentId).is_hidden).toBe(1);
    expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id = ?').get(newAssignmentId).is_hidden).toBe(0);
    expect(db.prepare('SELECT is_hidden, granted_by_admin FROM user_channels WHERE id = ?').get(grantedAssignmentId)).toEqual({ is_hidden: 0, granted_by_admin: 1 });
    expect(db.prepare('SELECT id FROM authorized_user_channels ORDER BY id').all()).toEqual([
      { id: newAssignmentId },
      { id: grantedAssignmentId },
    ]);
    expect(db.prepare("SELECT details FROM security_logs WHERE action = 'provider_owner_changed'").get().details).toContain('revoked 1 ungranted assignment(s)');
    expect(clearChannelsCache).toHaveBeenCalledWith();
  });
});
