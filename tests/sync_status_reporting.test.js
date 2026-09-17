import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { fetchSafe, xtreamState, hooks } = vi.hoisted(() => ({
  fetchSafe: vi.fn(),
  xtreamState: { channels: null, error: null },
  hooks: { beforeSeries: null },
}));
const memDb = new Database(':memory:');

vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', () => ({ fetchSafe }));
vi.mock('@iptv/xtream-api', () => ({
  Xtream: class {
    getChannels() {
      if (xtreamState.error) return Promise.reject(xtreamState.error);
      return Promise.resolve((xtreamState.channels || []).map(channel => ({ ...channel })));
    }
  },
}));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../src/utils/playlistParser.js', () => ({ parseM3uStream: vi.fn().mockResolvedValue({ isM3u: false }) }));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));
vi.mock('../src/services/ai/syncHistory.js', () => ({
  captureSyncSnapshot: () => null,
  recordSyncSnapshot: () => [],
  scheduleSyncFollowups: () => {},
}));
vi.mock('../src/services/seriesSyncService.js', () => ({
  parseSeriesInfoEpisodes: vi.fn(),
  syncSeriesEpisode: vi.fn(),
  syncSeriesEpisodes: vi.fn().mockResolvedValue(undefined),
}));

const aborted = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};
const jsonResponse = payload => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => payload,
});

/** Route the mocked fetchSafe by Xtream action; anything unlisted aborts. */
function routeFetch(routes) {
  fetchSafe.mockImplementation(async url => {
    const action = new URL(url).searchParams.get('action') || 'base';
    if (action === 'get_series' && hooks.beforeSeries) hooks.beforeSeries();
    const route = routes[action];
    if (!route) throw aborted();
    if (typeof route === 'function') return route();
    return jsonResponse(route);
  });
}

describe('sync status reporting', () => {
  let performSync;
  let calculateRetrySync;
  let finishSyncRun;

  beforeAll(async () => {
    ({ performSync, calculateRetrySync, finishSyncRun } = await import('../src/services/syncService.js'));
    memDb.pragma('foreign_keys = ON');
    memDb.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
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
      CREATE TABLE epg_channel_mappings (id INTEGER PRIMARY KEY, provider_channel_id INTEGER);
      CREATE TABLE stream_stats (id INTEGER PRIMARY KEY, channel_id INTEGER);
      CREATE TABLE provider_sync_state (
        provider_id INTEGER, stream_type TEXT,
        empty_snapshot_count INTEGER NOT NULL DEFAULT 0,
        last_nonempty_count INTEGER NOT NULL DEFAULT 0,
        last_snapshot_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(provider_id, stream_type)
      );
      CREATE TABLE sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        sync_time INTEGER NOT NULL, status TEXT NOT NULL, channels_added INTEGER DEFAULT 0,
        channels_updated INTEGER DEFAULT 0, categories_added INTEGER DEFAULT 0, error_message TEXT,
        FOREIGN KEY (provider_id) REFERENCES providers(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE security_logs (id INTEGER PRIMARY KEY, ip TEXT, action TEXT, details TEXT, timestamp INTEGER);
      CREATE TABLE category_mappings (
        id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER,
        provider_category_id INTEGER, provider_category_name TEXT,
        user_category_id INTEGER, auto_created INTEGER, category_type TEXT
      );
      CREATE TABLE user_channels (
        id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER,
        sort_order INTEGER, is_hidden INTEGER DEFAULT 0,
        assignment_origin TEXT NOT NULL DEFAULT 'legacy',
        mapping_id INTEGER, granted_by_admin INTEGER NOT NULL DEFAULT 0,
        authorization_revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE user_categories (
        id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, is_adult INTEGER, sort_order INTEGER, type TEXT
      );
    `);
  });

  afterAll(() => memDb.close());

  beforeEach(() => {
    for (const table of [
      'sync_logs', 'security_logs', 'epg_channel_mappings', 'stream_stats', 'user_channels',
      'provider_channels', 'provider_sync_state', 'category_mappings', 'user_categories',
      'sync_configs', 'providers', 'users',
    ]) memDb.prepare(`DELETE FROM ${table}`).run();
    vi.clearAllMocks();
    hooks.beforeSeries = null;
    xtreamState.channels = null;
    xtreamState.error = aborted();

    memDb.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('owner');
    memDb.prepare(`INSERT INTO providers (id, name, url, username, password, user_id)
                   VALUES (7, 'p7', 'http://provider.example', 'u', 'p', 1)`).run();
    memDb.prepare(`INSERT INTO sync_configs
                     (id, provider_id, user_id, enabled, sync_interval, auto_add_channels,
                      auto_add_categories, last_sync, next_sync, sync_series_episodes)
                   VALUES (1, 7, 1, 1, 'daily', 1, 1, 111, 222, 0)`).run();
  });

  const logs = () => memDb.prepare('SELECT * FROM sync_logs ORDER BY id').all();
  const config = () => memDb.prepare('SELECT * FROM sync_configs WHERE id = 1').get();

  it('reports an unreachable provider as an error instead of a 0/0/0 success', async () => {
    routeFetch({});                                   // every catalog call aborts
    const result = await performSync(7, 1, { mode: 'manual' });

    expect(result.status).toBe('error');
    expect(result.channelsAdded).toBe(0);
    expect(result.channelsUpdated).toBe(0);
    expect(result.errorMessage).toMatch(/live|vod|series/);

    const rows = logs();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('error');
    expect(rows[0].error_message).toBeTruthy();
    // last_sync records the last run that delivered something, so it stays put.
    expect(config().last_sync).toBe(111);
  });

  it('retries a failed provider earlier than the configured interval', async () => {
    routeFetch({});
    const before = Math.floor(Date.now() / 1000);
    await performSync(7, 1, { mode: 'manual' });

    const next = config().next_sync;
    expect(next).toBeGreaterThan(before);
    expect(next).toBeLessThanOrEqual(before + 900 + 5);   // first retry: 15 minutes
    expect(next).toBeLessThan(before + 86400);            // and well inside the daily interval
  });

  it('backs off further with every consecutive failure', () => {
    const cfg = config();
    const now = Math.floor(Date.now() / 1000);
    const insert = memDb.prepare(
      'INSERT INTO sync_logs (provider_id, user_id, sync_time, status) VALUES (7, 1, ?, ?)'
    );
    expect(calculateRetrySync(cfg, 7, 1)).toBeLessThanOrEqual(now + 900 + 5);
    insert.run(now, 'error');
    expect(calculateRetrySync(cfg, 7, 1)).toBeGreaterThan(now + 900 + 5);
    insert.run(now, 'error');
    insert.run(now, 'error');
    const third = calculateRetrySync(cfg, 7, 1);
    expect(third).toBeGreaterThan(now + 3600);
    expect(third).toBeLessThanOrEqual(now + 86400);       // never beyond the interval
  });

  it('never persists credentials or markup from an upstream failure', async () => {
    // fetchSafe embeds the request URL in some of its errors, and that URL
    // carries the provider account. sync_logs.error_message is rendered in the
    // admin UI, so upstream-controlled text must not survive either.
    fetchSafe.mockImplementation(async url => {
      throw new Error(`Unsafe URL: ${url}<img src=x onerror=alert(1)>`);
    });
    xtreamState.error = new Error('Unsafe URL: http://panel.example/player_api.php?username=bob&password=s3cr3t');

    const result = await performSync(7, 1, { mode: 'manual' });

    const stored = logs()[0].error_message || '';
    expect(stored).not.toMatch(/s3cr3t/);
    expect(stored).not.toMatch(/password=(?!\*)/);
    expect(stored).not.toMatch(/username=(?!\*)/);
    expect(stored).not.toMatch(/[<>]/);
    expect(stored.length).toBeLessThanOrEqual(300);
    expect(result.errorMessage).not.toMatch(/s3cr3t/);
  });

  it('does not mark a stream type complete when only its categories failed', async () => {
    routeFetch({
      get_series: [{ series_id: 5, name: 'S', cover: '' }],
      // get_series_categories deliberately missing -> aborts
    });
    const result = await performSync(7, 1, { mode: 'manual' });

    expect(result.status).toBe('partial');
    expect(logs()[0].status).toBe('partial');
    // provider_sync_state is only written for complete types; an incomplete one
    // must never become eligible for stale-row cleanup.
    const states = memDb.prepare('SELECT stream_type FROM provider_sync_state').all();
    expect(states.map(s => s.stream_type)).not.toContain('series');
  });

  it('reports a fully delivered catalog as success', async () => {
    xtreamState.error = null;
    xtreamState.channels = [{ name: 'Channel', stream_id: 101, category_id: 10, stream_icon: '', epg_channel_id: '', stream_type: 'live' }];
    routeFetch({
      get_live_categories: [{ category_id: 10, category_name: 'News' }],
      get_vod_streams: [],
      get_vod_categories: [],
      get_series: [],
      get_series_categories: [],
    });
    const startedAt = Math.floor(Date.now() / 1000);
    const result = await performSync(7, 1, { mode: 'manual' });

    expect(result.status).toBe('success');
    expect(logs()[0].status).toBe('success');
    expect(config().last_sync).toBeGreaterThanOrEqual(startedAt);
  });

  it('survives a provider that is deleted while its catalog is fetched', async () => {
    xtreamState.error = null;
    xtreamState.channels = [];
    hooks.beforeSeries = () => {
      memDb.prepare('DELETE FROM sync_configs WHERE provider_id = 7').run();
      memDb.prepare('DELETE FROM providers WHERE id = 7').run();
    };
    routeFetch({
      get_live_categories: [],
      get_vod_streams: [],
      get_vod_categories: [],
      get_series: [],
      get_series_categories: [],
    });

    const result = await performSync(7, 1, { mode: 'manual' });

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/removed/i);
    // The old code inserted into sync_logs regardless and hit
    // SQLITE_CONSTRAINT_FOREIGNKEY twice, the second time escaping performSync.
    expect(logs()).toHaveLength(0);
  });

  it('finishSyncRun never throws when the log target is gone', () => {
    memDb.prepare('DELETE FROM sync_configs WHERE provider_id = 7').run();
    memDb.prepare('DELETE FROM providers WHERE id = 7').run();
    expect(() => finishSyncRun({
      providerId: 7, userId: 1, startTime: 123, config: null,
      status: 'error', errorMessage: 'boom',
    })).not.toThrow();
    expect(logs()).toHaveLength(0);
  });

  it('finishSyncRun updates the schedule before writing the log', () => {
    // A failing log insert must not leave next_sync behind: the scheduler would
    // otherwise restart the provider every minute.
    memDb.prepare('DELETE FROM users WHERE id = 1').run();
    const cfg = config();
    finishSyncRun({
      providerId: 7, userId: 1, startTime: 123, config: cfg,
      status: 'error', errorMessage: 'boom',
    });
    expect(config().next_sync).not.toBe(222);
    expect(logs()).toHaveLength(0);
  });
});
