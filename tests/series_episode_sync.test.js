import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');

// Mock dependencies before importing the module under test
vi.doMock('../src/database/db.js', () => ({
  default: memDb,
  initDb: () => {}
}));

vi.mock('node-fetch', () => ({
  default: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
      headers: { get: () => 'application/json' }
  })
}));

vi.mock('@iptv/xtream-api', () => ({
  Xtream: class {
      constructor() {}
      getChannels() { return Promise.resolve([]); }
  }
}));

vi.mock('../src/utils/crypto.js', () => ({
  decrypt: (val) => val,
  encrypt: (val) => val
}));

vi.mock('../src/utils/helpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isAdultCategory: () => false,
    safeLookup: vi.fn(),
    isSafeUrl: vi.fn().mockResolvedValue(true)
  };
});

vi.mock('../src/utils/playlistParser.js', () => ({
    parseM3uStream: () => ({ isM3u: false })
}));

vi.mock('../src/services/cacheService.js', () => ({
    clearChannelsCache: vi.fn()
}));

vi.mock('../src/services/logoResolver.js', () => ({
    prePopulateProviderIconCache: vi.fn()
}));

const { fetchSafeMock } = vi.hoisted(() => ({ fetchSafeMock: vi.fn() }));
vi.mock('../src/utils/network.js', () => ({
    fetchSafe: fetchSafeMock
}));

const seriesInfoResponse = (episodesBySeason) => ({
  ok: true,
  json: async () => ({ info: { name: 'Test Show' }, episodes: episodesBySeason })
});

// providerSourceKey('http://prov.example') — episodes are keyed by upstream URL
const SOURCE = 'http://prov.example:80';

describe('Series episode sync', () => {
  let parseSeriesInfoEpisodes, syncSeriesEpisodes;

  beforeAll(async () => {
    memDb.exec(`
      CREATE TABLE providers (
        id INTEGER PRIMARY KEY,
        name TEXT, url TEXT, username TEXT, password TEXT
      );
      CREATE TABLE provider_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        remote_stream_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        stream_type TEXT DEFAULT 'live',
        metadata TEXT,
        UNIQUE(provider_id, remote_stream_id)
      );
      CREATE TABLE provider_series_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        remote_episode_id INTEGER NOT NULL,
        season INTEGER DEFAULT 0,
        episode_num INTEGER DEFAULT 0,
        title TEXT DEFAULT '',
        container_extension TEXT DEFAULT 'mp4',
        logo TEXT DEFAULT '',
        added TEXT DEFAULT '',
        UNIQUE(source_key, remote_episode_id)
      );
      CREATE TABLE provider_series_state (
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        last_modified TEXT DEFAULT '',
        synced_at INTEGER DEFAULT 0,
        PRIMARY KEY (source_key, series_remote_id)
      );
    `);
    // Two provider rows for the SAME upstream panel (different users/credentials)
    memDb.prepare('INSERT INTO providers (id, name, url, username, password) VALUES (1, ?, ?, ?, ?)')
      .run('Account A', 'http://prov.example', 'userA', 'passA');
    memDb.prepare('INSERT INTO providers (id, name, url, username, password) VALUES (2, ?, ?, ?, ?)')
      .run('Account B', 'http://prov.example/', 'userB', 'passB');

    const mod = await import('../src/services/syncService.js');
    parseSeriesInfoEpisodes = mod.parseSeriesInfoEpisodes;
    syncSeriesEpisodes = mod.syncSeriesEpisodes;
  });

  beforeEach(() => {
    fetchSafeMock.mockReset();
    memDb.prepare('DELETE FROM provider_channels').run();
    memDb.prepare('DELETE FROM provider_series_episodes').run();
    memDb.prepare('DELETE FROM provider_series_state').run();
  });

  describe('parseSeriesInfoEpisodes', () => {
    it('parses object-of-seasons payloads', () => {
      const eps = parseSeriesInfoEpisodes({
        episodes: {
          '1': [
            { id: '10', episode_num: 1, season: 1, title: 'Pilot', container_extension: 'mkv', info: { movie_image: 'ep.jpg' }, added: '123' },
            { id: '11', episode_num: 2, season: 1 }
          ],
          '2': [ { id: '20', episode_num: '1', season: '2', title: 'S2E1' } ]
        }
      });
      expect(eps).toHaveLength(3);
      expect(eps[0]).toEqual({
        remote_episode_id: 10, season: 1, episode_num: 1, title: 'Pilot',
        container_extension: 'mkv', logo: 'ep.jpg', added: '123'
      });
      expect(eps[2].season).toBe(2);
      expect(eps[2].container_extension).toBe('mp4');
    });

    it('parses array-of-seasons payloads and skips invalid entries', () => {
      const eps = parseSeriesInfoEpisodes({
        episodes: [
          [ { id: 5, episode_num: 1, season: 1 }, { title: 'no id' } ],
          'garbage'
        ]
      });
      expect(eps).toHaveLength(1);
      expect(eps[0].remote_episode_id).toBe(5);
    });

    it('returns empty for missing/invalid payloads', () => {
      expect(parseSeriesInfoEpisodes(null)).toEqual([]);
      expect(parseSeriesInfoEpisodes({})).toEqual([]);
    });
  });

  describe('syncSeriesEpisodes', () => {
    it('fetches and stores episodes for new series under the source key', async () => {
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"1000"}')`).run();

      fetchSafeMock.mockResolvedValue(seriesInfoResponse({
        '1': [
          { id: 100, episode_num: 1, season: 1, container_extension: 'mkv' },
          { id: 101, episode_num: 2, season: 1, container_extension: 'mkv' }
        ]
      }));

      const result = await syncSeriesEpisodes(1);
      expect(result.synced).toBe(1);
      expect(fetchSafeMock).toHaveBeenCalledTimes(1);
      expect(fetchSafeMock.mock.calls[0][0]).toContain('action=get_series_info&series_id=555');
      expect(fetchSafeMock.mock.calls[0][0]).toContain('username=userA');

      const rows = memDb.prepare('SELECT * FROM provider_series_episodes ORDER BY remote_episode_id').all();
      expect(rows).toHaveLength(2);
      expect(rows[0].source_key).toBe(SOURCE);
      expect(rows[0].series_remote_id).toBe(555);

      const state = memDb.prepare('SELECT * FROM provider_series_state').get();
      expect(state.source_key).toBe(SOURCE);
      expect(state.last_modified).toBe('1000');
    });

    it('does not refetch for a second provider of the same upstream panel', async () => {
      // Same series visible in both accounts
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"1000"}')`).run();
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (2, 555, 'Test Show', 'series', '{"last_modified":"1000"}')`).run();

      fetchSafeMock.mockResolvedValue(seriesInfoResponse({
        '1': [ { id: 100, episode_num: 1, season: 1 } ]
      }));

      await syncSeriesEpisodes(1);
      expect(fetchSafeMock).toHaveBeenCalledTimes(1);

      // Account B syncs the same panel: everything is already up to date
      const second = await syncSeriesEpisodes(2);
      expect(second.synced).toBe(0);
      expect(fetchSafeMock).toHaveBeenCalledTimes(1);

      // Only ONE copy of the episode exists
      expect(memDb.prepare('SELECT COUNT(*) as c FROM provider_series_episodes').get().c).toBe(1);
    });

    it('skips unchanged series and prunes episodes of removed series', async () => {
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"1000"}')`).run();
      memDb.prepare(`INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
        VALUES (?, 555, '1000', strftime('%s','now'))`).run(SOURCE);
      // Episodes of a series that no longer exists at the provider
      memDb.prepare(`INSERT INTO provider_series_episodes (source_key, series_remote_id, remote_episode_id)
        VALUES (?, 999, 42)`).run(SOURCE);

      const result = await syncSeriesEpisodes(1);
      expect(result.synced).toBe(0);
      expect(fetchSafeMock).not.toHaveBeenCalled();
      expect(memDb.prepare('SELECT COUNT(*) as c FROM provider_series_episodes WHERE series_remote_id = 999').get().c).toBe(0);
    });

    it('keeps episodes of series that only exist in a sibling provider account', async () => {
      // Series 777 exists only in account B; account A syncing must not prune it
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"1000"}')`).run();
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (2, 777, 'B Only Show', 'series', '{"last_modified":"1000"}')`).run();
      memDb.prepare(`INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
        VALUES (?, 555, '1000', strftime('%s','now')), (?, 777, '1000', strftime('%s','now'))`).run(SOURCE, SOURCE);
      memDb.prepare(`INSERT INTO provider_series_episodes (source_key, series_remote_id, remote_episode_id)
        VALUES (?, 777, 43)`).run(SOURCE);

      await syncSeriesEpisodes(1);
      expect(memDb.prepare('SELECT COUNT(*) as c FROM provider_series_episodes WHERE series_remote_id = 777').get().c).toBe(1);
    });

    it('refetches when last_modified changes and removes stale episodes', async () => {
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"2000"}')`).run();
      memDb.prepare(`INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
        VALUES (?, 555, '1000', strftime('%s','now'))`).run(SOURCE);
      memDb.prepare(`INSERT INTO provider_series_episodes (source_key, series_remote_id, remote_episode_id, season, episode_num)
        VALUES (?, 555, 100, 1, 1), (?, 555, 101, 1, 2)`).run(SOURCE, SOURCE);

      // Episode 101 disappeared, 102 is new
      fetchSafeMock.mockResolvedValue(seriesInfoResponse({
        '1': [
          { id: 100, episode_num: 1, season: 1 },
          { id: 102, episode_num: 3, season: 1 }
        ]
      }));

      const result = await syncSeriesEpisodes(1);
      expect(result.synced).toBe(1);
      const ids = memDb.prepare('SELECT remote_episode_id FROM provider_series_episodes ORDER BY remote_episode_id').all().map(r => r.remote_episode_id);
      expect(ids).toEqual([100, 102]);
      expect(memDb.prepare('SELECT last_modified FROM provider_series_state').get().last_modified).toBe('2000');
    });

    it('never queues series that originate from parsed M3U playlists', async () => {
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 888, 'M3U Series Entry', 'series', '{"original_url":"http://other.example/series/u/p/1.mkv"}')`).run();

      const result = await syncSeriesEpisodes(1);
      expect(result.synced).toBe(0);
      expect(fetchSafeMock).not.toHaveBeenCalled();
    });

    it('does not wipe episodes on error payloads', async () => {
      memDb.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type, metadata)
        VALUES (1, 555, 'Test Show', 'series', '{"last_modified":"3000"}')`).run();
      memDb.prepare(`INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
        VALUES (?, 555, '1000', 0)`).run(SOURCE);
      memDb.prepare(`INSERT INTO provider_series_episodes (source_key, series_remote_id, remote_episode_id)
        VALUES (?, 555, 100)`).run(SOURCE);

      fetchSafeMock.mockResolvedValue({ ok: true, json: async () => ({ user_info: { auth: 0 } }) });

      const result = await syncSeriesEpisodes(1);
      expect(result.failed).toBe(1);
      expect(memDb.prepare('SELECT COUNT(*) as c FROM provider_series_episodes').get().c).toBe(1);
      // State must not advance so the series is retried next sync
      expect(memDb.prepare('SELECT last_modified FROM provider_series_state').get().last_modified).toBe('1000');
    });
  });
});
