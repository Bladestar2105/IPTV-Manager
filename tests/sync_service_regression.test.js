import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { fetchSafe, xtreamState } = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
  xtreamState: { channels: [] },
}));
const memDb = new Database(':memory:');

vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn() }));
vi.mock('../src/utils/network.js', () => ({ fetchSafe }));
vi.mock('@iptv/xtream-api', () => ({
  Xtream: class {
    getChannels() { return Promise.resolve(xtreamState.channels.map(channel => ({ ...channel }))); }
  },
}));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../src/utils/playlistParser.js', () => ({ parseM3uStream: vi.fn().mockResolvedValue({ isM3u: false }) }));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));

describe('sync authorization regression', () => {
  let performSync;

  beforeAll(async () => {
    ({ performSync } = await import('../src/services/syncService.js'));
    memDb.exec(`
      CREATE TABLE providers (
        id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT,
        expiry_date INTEGER, user_id INTEGER
      );
      CREATE TABLE sync_configs (
        id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, enabled INTEGER,
        sync_interval TEXT, auto_add_channels INTEGER, auto_add_categories INTEGER,
        last_sync INTEGER, next_sync INTEGER, sync_series_episodes INTEGER,
        granted_by_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_channels (
        id INTEGER PRIMARY KEY, provider_id INTEGER, remote_stream_id INTEGER, name TEXT,
        original_category_id INTEGER, logo TEXT, stream_type TEXT, epg_channel_id TEXT,
        original_sort_order INTEGER, tv_archive INTEGER, tv_archive_duration INTEGER,
        metadata TEXT, mime_type TEXT, rating TEXT, rating_5based REAL, added TEXT,
        plot TEXT, "cast" TEXT, director TEXT, genre TEXT, releaseDate TEXT,
        youtube_trailer TEXT, episode_run_time TEXT,
        UNIQUE(provider_id, remote_stream_id)
      );
      CREATE TABLE sync_logs (
        id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, sync_time INTEGER,
        status TEXT, channels_added INTEGER, channels_updated INTEGER,
        categories_added INTEGER, error_message TEXT
      );
      CREATE TABLE security_logs (
        id INTEGER PRIMARY KEY, ip TEXT, action TEXT, details TEXT, timestamp INTEGER
      );
      CREATE TABLE category_mappings (
        id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER,
        provider_category_id INTEGER, provider_category_name TEXT,
        user_category_id INTEGER, auto_created INTEGER, category_type TEXT
      );
      CREATE TABLE user_channels (
        id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER,
        sort_order INTEGER, is_hidden INTEGER DEFAULT 0,
        granted_by_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE user_categories (
        id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, is_adult INTEGER,
        sort_order INTEGER, type TEXT
      );
    `);
  });

  beforeEach(() => {
    for (const table of [
      'security_logs', 'sync_logs', 'user_channels', 'provider_channels',
      'category_mappings', 'user_categories', 'sync_configs', 'providers',
    ]) {
      memDb.prepare(`DELETE FROM ${table}`).run();
    }
    vi.clearAllMocks();
    xtreamState.channels = [{
      name: 'Channel', stream_id: 101, category_id: 10,
      stream_icon: '', epg_channel_id: '', stream_type: 'live',
    }];
    fetchSafe.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => [],
    });
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (10, 1, 'Live', 'live', 0)").run();
    memDb.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (1, 1, 10, 'Live', 10, 0, 'live')
    `).run();
  });

  const configure = ({ providerOwner = 1, targetUser = 1, enabled = 1, grant = 0 } = {}) => {
    memDb.prepare(`
      INSERT INTO providers (id, name, url, username, password, user_id)
      VALUES (1, 'Provider', 'http://panel.test', 'provider-user', 'super-secret', ?)
    `).run(providerOwner);
    memDb.prepare(`
      INSERT INTO sync_configs
        (id, provider_id, user_id, enabled, sync_interval, auto_add_channels,
         auto_add_categories, sync_series_episodes, granted_by_admin)
      VALUES (7, 1, ?, ?, 'daily', 1, 0, 0, ?)
    `).run(targetUser, enabled, grant);
  };

  it('creates same-owner scheduled assignments with a normal grant', async () => {
    configure();

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toBe(null);
    expect(result.channelsAdded).toBe(1);
    expect(memDb.prepare('SELECT granted_by_admin, is_hidden FROM user_channels').get()).toEqual({
      granted_by_admin: 0,
      is_hidden: 0,
    });
  });

  it('disables an unapproved cross-owner config before network or writes', async () => {
    configure({ providerOwner: 2 });
    const categoriesBefore = memDb.prepare('SELECT COUNT(*) AS count FROM user_categories').get().count;

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toMatch(/explicit administrator approval/i);
    expect(fetchSafe).not.toHaveBeenCalled();
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_categories').get().count).toBe(categoriesBefore);
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs WHERE id = 7').get()).toEqual({
      enabled: 0,
      granted_by_admin: 0,
    });
    const log = memDb.prepare("SELECT details FROM security_logs WHERE action = 'cross_owner_sync_blocked'").get();
    expect(log.details).toContain('disabled 1 config(s)');
    expect(log.details).not.toContain('provider-user');
    expect(log.details).not.toContain('super-secret');
  });

  it('uses the persisted admin grant for a cross-owner scheduled sync', async () => {
    configure({ providerOwner: 2, grant: 1 });

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT granted_by_admin FROM user_channels').get()).toEqual({ granted_by_admin: 1 });
  });

  it('allows a trusted manual operation without authorizing future schedules', async () => {
    configure({ providerOwner: 2, enabled: 0, grant: 0 });

    const manual = await performSync(1, 1, { mode: 'manual', allowCrossOwner: true });
    expect(manual.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT granted_by_admin FROM user_channels').get()).toEqual({ granted_by_admin: 1 });
    expect(memDb.prepare('SELECT enabled, granted_by_admin FROM sync_configs WHERE id = 7').get()).toEqual({
      enabled: 0,
      granted_by_admin: 0,
    });

    memDb.prepare('DELETE FROM user_channels').run();
    xtreamState.channels = [{ ...xtreamState.channels[0], stream_id: 102 }];
    fetchSafe.mockClear();
    await performSync(1, 1, { mode: 'scheduled' });

    expect(fetchSafe).not.toHaveBeenCalled();
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
  });

  it('blocks a formerly same-owner config after the provider owner changes', async () => {
    configure();
    memDb.prepare('UPDATE providers SET user_id = 2 WHERE id = 1').run();

    await performSync(1, 1, { mode: 'scheduled' });

    expect(memDb.prepare('SELECT enabled FROM sync_configs WHERE id = 7').get()).toEqual({ enabled: 0 });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
    expect(fetchSafe).not.toHaveBeenCalled();
  });

  afterAll(() => memDb.close());
});
