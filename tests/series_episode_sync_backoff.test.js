import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
const memDb = new Database(':memory:');

vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', async importOriginal => ({ ...(await importOriginal()), fetchSafe }));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));

const { syncSeriesEpisodes } = await import('../src/services/seriesSyncService.js');
const { acquireSourceLock, clearProviderLocks, resetProviderLockState } =
  await import('../src/services/providerLockService.js');

const SOURCE = 'http://panel.example:80';

memDb.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT, user_id INTEGER);
  CREATE TABLE provider_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, remote_stream_id INTEGER,
    name TEXT, stream_type TEXT, metadata TEXT
  );
  CREATE TABLE provider_series_episodes (
    source_key TEXT NOT NULL, series_remote_id INTEGER NOT NULL, remote_episode_id INTEGER NOT NULL,
    season INTEGER, episode_num INTEGER, title TEXT, container_extension TEXT, logo TEXT, added TEXT,
    PRIMARY KEY (source_key, series_remote_id, remote_episode_id)
  );
  CREATE TABLE provider_series_state (
    source_key TEXT NOT NULL, series_remote_id INTEGER NOT NULL, last_modified TEXT, synced_at INTEGER,
    PRIMARY KEY (source_key, series_remote_id)
  );
`);

function seedSeries(count) {
  const insert = memDb.prepare(
    "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (1, ?, ?, 'series')"
  );
  memDb.transaction(() => {
    for (let i = 1; i <= count; i++) insert.run(i, `Series ${i}`);
  })();
}

const aborted = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

describe('episode sync back-off', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderLockState();
    clearProviderLocks();
    for (const table of ['provider_series_state', 'provider_series_episodes', 'provider_channels', 'providers']) {
      memDb.prepare(`DELETE FROM ${table}`).run();
    }
    memDb.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (1, ?, ?, ?, ?, 1)')
      .run('panel', SOURCE, 'u', 'p');
  });

  afterAll(() => memDb.close());

  it('stops a run against an upstream that answers nothing', async () => {
    // Production ground 36,086 series at one 30s timeout each, ~20 hours of
    // failing requests and 30 log lines per minute.
    seedSeries(400);
    fetchSafe.mockImplementation(async () => { throw aborted(); });

    const result = await syncSeriesEpisodes(1);

    expect(result.gaveUp).toBe(true);
    expect(result.synced).toBe(0);
    // Bounded by the consecutive-failure limit plus the in-flight requests of
    // the other workers, nowhere near the 400 queued series.
    expect(fetchSafe.mock.calls.length).toBeLessThan(60);
  }, 20000);

  it('keeps going when failures are interspersed with successes', async () => {
    seedSeries(60);
    let call = 0;
    fetchSafe.mockImplementation(async () => {
      call++;
      if (call % 3 === 0) throw aborted();
      return {
        ok: true,
        json: async () => ({ info: { name: 'x' }, episodes: { 1: [{ id: call, episode_num: 1, title: 't' }] } }),
      };
    });

    const result = await syncSeriesEpisodes(1);

    expect(result.gaveUp).toBeFalsy();
    expect(result.synced).toBeGreaterThan(30);
    expect(fetchSafe.mock.calls.length).toBe(60);
  }, 20000);

  it('gives up on a panel that refuses every request with an HTTP error', async () => {
    // A fast 429/5xx was a silent per-series skip, so a refusing panel still
    // received one request for every queued series.
    seedSeries(400);
    fetchSafe.mockImplementation(async () => ({ ok: false, status: 429, headers: { get: () => null } }));

    const result = await syncSeriesEpisodes(1);

    expect(result.gaveUp).toBe(true);
    expect(fetchSafe.mock.calls.length).toBeLessThan(60);
  }, 20000);

  it('does not give up because the local database is contended', async () => {
    // SQLITE_BUSY says the database is busy, not that the panel is down.
    // Counting it would drop the queue and blame the wrong side.
    seedSeries(400);
    fetchSafe.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ info: { name: 'x' }, episodes: { 1: [{ id: 1, episode_num: 1, title: 't' }] } }),
    }));
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      if (/INSERT INTO provider_series_episodes/i.test(sql)) {
        return { run: () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; } };
      }
      return original(sql);
    });
    try {
      const result = await syncSeriesEpisodes(1);
      expect(result.gaveUp).toBeFalsy();
      expect(result.dbFailures).toBeGreaterThan(0);
      // The whole queue was attempted rather than abandoned after 25 rows.
      expect(fetchSafe.mock.calls.length).toBe(400);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('does not cool the panel down because one account stopped working', async () => {
    // A lapsed subscription answers every request with an error while the panel
    // is healthy. Counting those against the panel ended the run for every
    // other account on it — and since a failed series never gets a state row,
    // that account's series are re-queued every cycle, so the panel would be
    // held back again and again on account of one dead login.
    memDb.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (2, ?, ?, ?, ?, 1)')
      .run('lapsed account', `${SOURCE}/`, 'expired', 'p2');
    const insert = memDb.prepare(
      "INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type) VALUES (?, ?, ?, 'series')"
    );
    memDb.transaction(() => {
      for (let i = 1; i <= 40; i++) insert.run(2, 1000 + i, `Lapsed ${i}`);
      for (let i = 1; i <= 5; i++) insert.run(1, i, `Good ${i}`);
    })();
    fetchSafe.mockImplementation(async url => {
      if (url.includes('username=expired')) return { ok: false, status: 401, headers: { get: () => null } };
      return { ok: true, json: async () => ({ info: { name: 'x' }, episodes: { 1: [{ id: 1, episode_num: 1, title: 't' }] } }) };
    });

    const result = await syncSeriesEpisodes(1);

    expect(result.gaveUp).toBe(false);
    expect(result.gaveUpProviders).toBe(1);
    // The healthy account's series were still synced.
    expect(result.synced).toBe(5);
    // And the source is free for the next run rather than cooling down.
    expect(memDb.prepare('SELECT COUNT(*) c FROM provider_locks').get().c).toBe(0);
  }, 30000);

  it('does not blame the panel for a local write failure with any SQLite code', async () => {
    // Classifying by "is this one of the three retryable codes" made a full
    // disk, an I/O error and a driver TypeError all look like an unanswering
    // panel, so SQLITE_FULL could cool a healthy upstream down for half an hour.
    seedSeries(400);
    fetchSafe.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ info: { name: 'x' }, episodes: { 1: [{ id: 1, episode_num: 1, title: 't' }] } }),
    }));
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      if (/INSERT INTO provider_series_episodes/i.test(sql)) {
        return { run: () => { const e = new Error('database or disk is full'); e.code = 'SQLITE_FULL'; throw e; } };
      }
      return original(sql);
    });
    try {
      const result = await syncSeriesEpisodes(1);

      expect(result.gaveUp).toBe(false);
      expect(result.dbFailures).toBeGreaterThan(0);
      expect(memDb.prepare('SELECT COUNT(*) c FROM provider_locks').get().c).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  it('holds the source back after giving up so its siblings do not repeat the run', async () => {
    // The breaker was scoped to one run. Nine provider rows share one panel on
    // the affected deployment, so a dead host used to cost the full failure
    // budget once per sibling, per cycle: the lock frees, the next sibling takes
    // it and grinds through its own 25 timeouts against the same dead host.
    memDb.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (2, ?, ?, ?, ?, 1)')
      .run('same panel, other account', `${SOURCE}/`, 'u2', 'p2');
    seedSeries(400);
    fetchSafe.mockImplementation(async () => { throw aborted(); });

    const first = await syncSeriesEpisodes(1);
    expect(first.gaveUp).toBe(true);
    const spent = fetchSafe.mock.calls.length;

    const sibling = await syncSeriesEpisodes(2);

    expect(sibling).toEqual({ skipped: true });
    expect(fetchSafe.mock.calls.length).toBe(spent);
  }, 30000);

  it('frees the source again as soon as the cooldown has run out', async () => {
    seedSeries(400);
    fetchSafe.mockImplementation(async () => { throw aborted(); });
    await syncSeriesEpisodes(1);

    // The cooldown is a lease, not a permanent block: expire it the way time
    // would and the next run proceeds.
    memDb.prepare('UPDATE provider_locks SET expires_at = 0').run();
    fetchSafe.mockClear();

    const second = await syncSeriesEpisodes(1);

    expect(second.gaveUp).toBe(true);
    expect(fetchSafe.mock.calls.length).toBeGreaterThan(0);
  }, 30000);

  it('does not start a second run for a panel another worker is syncing', async () => {
    seedSeries(10);
    fetchSafe.mockImplementation(async () => { throw aborted(); });

    // Nine of eleven providers share one panel on the affected deployment, and
    // the in-process guard cannot see a run in another cluster worker.
    const held = acquireSourceLock(SOURCE, 'episodes');
    expect(held).not.toBeNull();
    try {
      await expect(syncSeriesEpisodes(1)).resolves.toMatchObject({ skipped: true });
      expect(fetchSafe).not.toHaveBeenCalled();
    } finally {
      held.release();
    }

    // Released again: the next run proceeds.
    const after = await syncSeriesEpisodes(1);
    expect(after.skipped).toBeFalsy();
  }, 20000);

  it('releases the panel lock when the run ends', async () => {
    seedSeries(5);
    fetchSafe.mockImplementation(async () => { throw aborted(); });
    await syncSeriesEpisodes(1);

    const again = acquireSourceLock(SOURCE, 'episodes');
    expect(again).not.toBeNull();
    again.release();
  }, 20000);
});
