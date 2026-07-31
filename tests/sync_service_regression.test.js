import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';

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
  let selectStaleProviderChannels;
  let deleteProviderChannelCascade;

  beforeAll(async () => {
    ({ performSync, selectStaleProviderChannels, deleteProviderChannelCascade } = await import('../src/services/syncService.js'));
    memDb.pragma('foreign_keys = ON');
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
      CREATE TABLE epg_channel_mappings (
        id INTEGER PRIMARY KEY, provider_channel_id INTEGER,
        FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id)
      );
      CREATE TABLE stream_stats (
        id INTEGER PRIMARY KEY, channel_id INTEGER,
        FOREIGN KEY (channel_id) REFERENCES provider_channels(id)
      );
      CREATE TABLE provider_sync_state (
        provider_id INTEGER, stream_type TEXT,
        empty_snapshot_count INTEGER NOT NULL DEFAULT 0,
        last_nonempty_count INTEGER NOT NULL DEFAULT 0,
        last_snapshot_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider_id, stream_type)
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
        assignment_origin TEXT NOT NULL DEFAULT 'legacy'
          CHECK (assignment_origin IN ('legacy', 'manual', 'mapping', 'imported')),
        mapping_id INTEGER,
        granted_by_admin INTEGER NOT NULL DEFAULT 0,
        authorization_revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE series_episode_aliases (
        id INTEGER PRIMARY KEY,
        user_channel_id INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        remote_episode_id INTEGER NOT NULL,
        UNIQUE(user_channel_id, source_key, series_remote_id, remote_episode_id),
        FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
      );
      CREATE TABLE user_categories (
        id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, is_adult INTEGER,
        sort_order INTEGER, type TEXT
      );
    `);
  });

  beforeEach(() => {
    for (const table of [
      'security_logs', 'sync_logs', 'series_episode_aliases',
      'epg_channel_mappings', 'stream_stats', 'user_channels', 'provider_channels', 'provider_sync_state',
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
    xtreamState.channels[0].container_extension = 'ts\r\n#EXTINF:-1,Injected';

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toBe(null);
    expect(result.channelsAdded).toBe(1);
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked, is_hidden FROM user_channels').get()).toEqual({
      granted_by_admin: 0,
      authorization_revoked: 0,
      is_hidden: 0,
    });
    expect(memDb.prepare('SELECT mime_type FROM provider_channels').get()).toEqual({ mime_type: 'ts' });
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
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels').get()).toEqual({
      granted_by_admin: 1,
      authorization_revoked: 0,
    });
  });

  it('ignores a legacy mapping that targets another tenant during sync', async () => {
    configure();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (20, 2, 'Foreign', 'live', 0)").run();
    memDb.prepare('UPDATE category_mappings SET user_category_id = 20 WHERE id = 1').run();

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(1);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
  });

  it('allows a trusted manual operation without authorizing future schedules', async () => {
    configure({ providerOwner: 2, enabled: 0, grant: 0 });

    const manual = await performSync(1, 1, { mode: 'manual', allowCrossOwner: true });
    expect(manual.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels').get()).toEqual({
      granted_by_admin: 1,
      authorization_revoked: 0,
    });
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

  it('an approved scheduled sync restores authorization without unhiding the assignment', async () => {
    configure({ providerOwner: 2, grant: 1 });
    memDb.prepare(`
      INSERT INTO provider_channels
        (id, provider_id, remote_stream_id, name, original_category_id, stream_type)
      VALUES (20, 1, 101, 'Old Channel', 10, 'live')
    `).run();
    memDb.prepare(`
      INSERT INTO user_channels
        (id, user_category_id, provider_channel_id, sort_order, is_hidden,
         granted_by_admin, authorization_revoked)
      VALUES (30, 10, 20, 0, 1, 0, 1)
    `).run();

    const result = await performSync(1, 1, { mode: 'scheduled' });

    expect(result.errorMessage).toBe(null);
    expect(memDb.prepare(`
      SELECT is_hidden, granted_by_admin, authorization_revoked
      FROM user_channels WHERE id = 30
    `).get()).toEqual({
      is_hidden: 1,
      granted_by_admin: 1,
      authorization_revoked: 0,
    });
  });

  it('requires the explicit restore flag for a manual cross-owner reconciliation', async () => {
    configure({ providerOwner: 2, enabled: 0 });
    memDb.prepare(`
      INSERT INTO provider_channels
        (id, provider_id, remote_stream_id, name, original_category_id, stream_type)
      VALUES (20, 1, 101, 'Old Channel', 10, 'live')
    `).run();
    memDb.prepare(`
      INSERT INTO user_channels
        (id, user_category_id, provider_channel_id, authorization_revoked)
      VALUES (30, 10, 20, 1)
    `).run();

    await performSync(1, 1, { mode: 'manual', allowCrossOwner: true });
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels WHERE id = 30').get())
      .toEqual({ granted_by_admin: 0, authorization_revoked: 1 });

    await performSync(1, 1, {
      mode: 'manual',
      allowCrossOwner: true,
      restoreRevokedAssignments: true,
    });
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels WHERE id = 30').get())
      .toEqual({ granted_by_admin: 1, authorization_revoked: 0 });
  });

  it('maintains parallel live and radio mappings without duplicate assignments', async () => {
    configure();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (20, 1, 'Radio', 'radio', 1)").run();
    memDb.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (1, 1, 10, 'Live as Radio', 20, 0, 'radio')
    `).run();

    await performSync(1, 1, { mode: 'scheduled' });
    let assignments = memDb.prepare(`
      SELECT user_category_id, provider_channel_id, mapping_id, is_hidden
      FROM user_channels ORDER BY user_category_id
    `).all();
    expect(assignments).toHaveLength(2);
    expect(assignments[0].provider_channel_id).toBe(assignments[1].provider_channel_id);
    expect(assignments.every(assignment => assignment.mapping_id)).toBe(true);

    memDb.prepare('UPDATE user_channels SET is_hidden = 1 WHERE user_category_id = 20').run();
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT is_hidden FROM user_channels WHERE user_category_id = 20').get()).toEqual({ is_hidden: 1 });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(2);
  });

  it('reconciles mapped radio assignments on category movement but preserves manual assignments', async () => {
    configure();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (20, 1, 'Radio A', 'radio', 1)").run();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (30, 1, 'Live B', 'live', 2)").run();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (40, 1, 'Radio B', 'radio', 3)").run();
    memDb.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES
        (1, 1, 10, 'Live as Radio A', 20, 0, 'radio'),
        (1, 1, 11, 'Live B', 30, 0, 'live'),
        (1, 1, 11, 'Live B as Radio', 40, 0, 'radio')
    `).run();
    await performSync(1, 1, { mode: 'scheduled' });
    const providerChannelId = memDb.prepare('SELECT id FROM provider_channels WHERE remote_stream_id = 101').get().id;
    memDb.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (30, ?, 99)').run(providerChannelId);

    xtreamState.channels = [{ ...xtreamState.channels[0], category_id: 11 }];
    await performSync(1, 1, { mode: 'scheduled' });

    const assignments = memDb.prepare(`
      SELECT user_category_id, mapping_id
      FROM user_channels WHERE provider_channel_id = ? ORDER BY user_category_id
    `).all(providerChannelId);
    expect(assignments.map(assignment => assignment.user_category_id)).toEqual([30, 40]);
    expect(assignments.filter(assignment => assignment.user_category_id === 30 && assignment.mapping_id === null)).toHaveLength(1);
  });

  it('applies existing cross-owner authorization rules to radio mappings', async () => {
    configure({ providerOwner: 2, grant: 1 });
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (20, 1, 'Radio', 'radio', 1)").run();
    memDb.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (1, 1, 10, 'Live as Radio', 20, 0, 'radio')
    `).run();

    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT granted_by_admin, authorization_revoked FROM user_channels WHERE user_category_id = 20').get())
      .toEqual({ granted_by_admin: 1, authorization_revoked: 0 });

    memDb.prepare('DELETE FROM user_channels').run();
    memDb.prepare('UPDATE sync_configs SET granted_by_admin = 0').run();
    const blocked = await performSync(1, 1, { mode: 'scheduled' });
    expect(blocked.errorMessage).toMatch(/explicit administrator approval/i);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
  });

  it('removes disappeared provider channels and both mapped assignments', async () => {
    configure();
    memDb.prepare("INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (20, 1, 'Radio', 'radio', 1)").run();
    memDb.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (1, 1, 10, 'Live as Radio', 20, 0, 'radio')
    `).run();

    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(2);

    xtreamState.channels = [];
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(1);
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
  });

  it('removes stale channels with EPG, stream-stat, assignment, and alias dependencies', async () => {
    configure();
    await performSync(1, 1, { mode: 'scheduled' });
    const channel = memDb.prepare('SELECT id FROM provider_channels WHERE remote_stream_id = 101').get();
    const assignment = memDb.prepare('SELECT id FROM user_channels WHERE provider_channel_id = ?').get(channel.id);
    memDb.prepare('INSERT INTO epg_channel_mappings (id, provider_channel_id) VALUES (1, ?)').run(channel.id);
    memDb.prepare('INSERT INTO stream_stats (id, channel_id) VALUES (1, ?)').run(channel.id);
    memDb.prepare(`
      INSERT INTO series_episode_aliases
        (id, user_channel_id, source_key, series_remote_id, remote_episode_id)
      VALUES (1, ?, 'source', 101, 1)
    `).run(assignment.id);

    xtreamState.channels = [];
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(1);
    await performSync(1, 1, { mode: 'scheduled' });

    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM epg_channel_mappings').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM stream_stats').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM series_episode_aliases').get().count).toBe(0);
  });

  it('does not delete a channel belonging to another provider', () => {
    memDb.prepare("INSERT INTO providers (id, name, url, username, password, user_id) VALUES (2, 'Other', 'http://other.test', 'u', 'p', 2)").run();
    const channel = memDb.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (2, 202, 'Other', 'live')").run().lastInsertRowid;
    expect(deleteProviderChannelCascade(memDb, 1, channel)).toBe(0);
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(channel)).toEqual({ id: channel });
  });

  it('rolls back the full synchronization when a dependent cleanup fails', async () => {
    configure();
    await performSync(1, 1, { mode: 'scheduled' });
    const channel = memDb.prepare('SELECT id FROM provider_channels WHERE remote_stream_id = 101').get();
    memDb.prepare('INSERT INTO stream_stats (id, channel_id) VALUES (1, ?)').run(channel.id);
    memDb.exec(`
      CREATE TRIGGER fail_stream_stat_delete
      BEFORE DELETE ON stream_stats
      BEGIN SELECT RAISE(FAIL, 'dependent cleanup failure'); END;
    `);
    xtreamState.channels = [];
    await performSync(1, 1, { mode: 'scheduled' });
    const failed = await performSync(1, 1, { mode: 'scheduled' });
    expect(failed.errorMessage).toMatch(/dependent cleanup failure/);
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(channel.id)).toEqual({ id: channel.id });
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(1);
    memDb.exec('DROP TRIGGER fail_stream_stat_delete');
  });

  it('confirms empty VOD snapshots independently from live and ignores failed or invalid responses', async () => {
    configure();
    await performSync(1, 1, { mode: 'scheduled' });
    const movie = memDb.prepare(`
      INSERT INTO provider_channels
        (provider_id, remote_stream_id, name, stream_type)
      VALUES (1, 900, 'Movie', 'movie')
    `).run().lastInsertRowid;

    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(movie)).toEqual({ id: movie });
    expect(memDb.prepare("SELECT empty_snapshot_count FROM provider_sync_state WHERE provider_id = 1 AND stream_type = 'movie'").get())
      .toEqual({ empty_snapshot_count: 1 });
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(movie)).toBeUndefined();

    const secondMovie = memDb.prepare(`
      INSERT INTO provider_channels
        (provider_id, remote_stream_id, name, stream_type)
      VALUES (1, 901, 'Movie 2', 'movie')
    `).run().lastInsertRowid;
    fetchSafe.mockImplementation(async url => {
      if (url.includes('action=get_vod_streams')) return { ok: false, status: 503, json: async () => [] };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] };
    });
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(secondMovie)).toEqual({ id: secondMovie });
    expect(memDb.prepare("SELECT empty_snapshot_count FROM provider_sync_state WHERE provider_id = 1 AND stream_type = 'movie'").get())
      .toEqual({ empty_snapshot_count: 2 });

    fetchSafe.mockImplementation(async url => {
      if (url.includes('action=get_vod_streams')) return { ok: true, status: 200, json: async () => ({ error: 'auth' }) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => [] };
    });
    await performSync(1, 1, { mode: 'scheduled' });
    expect(memDb.prepare('SELECT id FROM provider_channels WHERE id = ?').get(secondMovie)).toEqual({ id: secondMovie });
    expect(memDb.prepare("SELECT empty_snapshot_count FROM provider_sync_state WHERE provider_id = 1 AND stream_type = 'movie'").get())
      .toEqual({ empty_snapshot_count: 2 });
  });

  it('accepts an initially empty provider without creating destructive cleanup state', async () => {
    configure();
    xtreamState.channels = [];
    const result = await performSync(1, 1, { mode: 'scheduled' });
    expect(result.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(0);
    expect(memDb.prepare("SELECT empty_snapshot_count FROM provider_sync_state WHERE provider_id = 1 AND stream_type = 'live'").get())
      .toEqual({ empty_snapshot_count: 0 });
  });

  it('selects 40k live, VOD, and series catalogs deterministically without SQL placeholders', () => {
    const existing = [];
    const seen = new Map([
      ['live', new Set()], ['movie', new Set()], ['series', new Set()]
    ]);
    for (const type of ['live', 'movie', 'series']) {
      for (let id = 1; id <= 40000; id++) {
        existing.push({ id: existing.length + 1, remote_stream_id: id, stream_type: type });
        seen.get(type).add(id);
      }
    }
    existing.push({ id: existing.length + 1, remote_stream_id: 40001, stream_type: 'live' });
    const started = performance.now();
    const stale = selectStaleProviderChannels(existing, seen, new Set(['live', 'movie', 'series']));
    const elapsed = performance.now() - started;
    expect(stale).toEqual([{ id: 120001, remote_stream_id: 40001, stream_type: 'live' }]);
    console.info(`[Sync catalog benchmark] processed=${existing.length} stale=${stale.length} elapsed_ms=${elapsed.toFixed(1)} heap_delta_mib=${((process.memoryUsage().heapUsed) / 1024 / 1024).toFixed(1)} rss_mib=${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)}`);
  });

  it('synchronizes a 100,000-channel live catalog and removes one stale item', async () => {
    configure();
    memDb.prepare('UPDATE sync_configs SET auto_add_channels = 0').run();
    const catalog = Array.from({ length: 100000 }, (_, index) => ({
      name: `Channel ${index + 1}`,
      stream_id: index + 1,
      category_id: 10,
      stream_type: 'live'
    }));
    xtreamState.channels = catalog;
    const started = performance.now();
    const before = process.memoryUsage();
    const first = await performSync(1, 1, { mode: 'scheduled' });
    const elapsed = performance.now() - started;
    const after = process.memoryUsage();
    expect(first.errorMessage).toBe(null);
    expect(first.channelsAdded).toBe(100000);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(100000);
    console.info(`[Sync catalog benchmark] processed=100000 stale=0 elapsed_ms=${elapsed.toFixed(1)} heap_delta_mib=${((after.heapUsed - before.heapUsed) / 1024 / 1024).toFixed(1)} rss_delta_mib=${((after.rss - before.rss) / 1024 / 1024).toFixed(1)}`);

    xtreamState.channels = catalog.slice(1);
    const second = await performSync(1, 1, { mode: 'scheduled' });
    expect(second.errorMessage).toBe(null);
    expect(memDb.prepare('SELECT COUNT(*) AS count FROM provider_channels').get().count).toBe(99999);
  }, 120000);

  afterAll(() => memDb.close());
});
