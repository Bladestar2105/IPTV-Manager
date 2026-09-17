import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');

vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', () => ({ fetchSafe: vi.fn() }));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../src/utils/playlistParser.js', () => ({ parseM3uStream: vi.fn() }));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));
vi.mock('@iptv/xtream-api', () => ({ Xtream: class { getChannels() { return Promise.resolve([]); } } }));
vi.mock('../src/services/ai/syncHistory.js', () => ({
  captureSyncSnapshot: () => null, recordSyncSnapshot: () => [], scheduleSyncFollowups: () => {},
}));
vi.mock('../src/services/seriesSyncService.js', () => ({
  parseSeriesInfoEpisodes: vi.fn(), syncSeriesEpisode: vi.fn(), syncSeriesEpisodes: vi.fn(),
}));
vi.mock('../src/services/epgService.js', () => ({ updateProviderEpg: vi.fn().mockResolvedValue(undefined) }));

const {
  acquireProviderLock, describeProviderLock, clearProviderLocks, clearExpiredProviderLocks,
  resetProviderLockState,
} = await import('../src/services/providerLockService.js');
const { performSync } = await import('../src/services/syncService.js');
const { deleteProvider } = await import('../src/controllers/providerController.js');

memDb.exec(`
  CREATE TABLE provider_locks (
    provider_id INTEGER PRIMARY KEY, operation TEXT NOT NULL, owner_pid INTEGER NOT NULL,
    owner_token TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
  CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT, user_id INTEGER);
  CREATE TABLE provider_channels (id INTEGER PRIMARY KEY, provider_id INTEGER);
  CREATE TABLE sync_configs (id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, enabled INTEGER, sync_interval TEXT, last_sync INTEGER, next_sync INTEGER);
  CREATE TABLE sync_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, user_id INTEGER, sync_time INTEGER, status TEXT, channels_added INTEGER, channels_updated INTEGER, categories_added INTEGER, error_message TEXT);
  CREATE TABLE provider_sync_state (provider_id INTEGER, stream_type TEXT, PRIMARY KEY (provider_id, stream_type));
  CREATE TABLE category_mappings (id INTEGER PRIMARY KEY, provider_id INTEGER);
  CREATE TABLE provider_icon_cache (id INTEGER PRIMARY KEY, provider_id INTEGER);
`);

function resDouble() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

describe('provider lock', () => {
  beforeEach(() => {
    resetProviderLockState();
    clearProviderLocks();
    memDb.prepare('DELETE FROM sync_logs').run();
    memDb.prepare('DELETE FROM providers').run();
    memDb.prepare('DELETE FROM users').run();
    memDb.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('owner');
    memDb.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (7, ?, ?, ?, ?, 1)')
      .run('p7', 'http://provider.example', 'u', 'p');
  });

  afterAll(() => memDb.close());

  it('grants the lock to exactly one holder', () => {
    const first = acquireProviderLock(7, 'sync');
    expect(first).not.toBeNull();
    expect(acquireProviderLock(7, 'delete')).toBeNull();
    expect(describeProviderLock(7).operation).toBe('sync');

    first.release();
    const second = acquireProviderLock(7, 'delete');
    expect(second).not.toBeNull();
    second.release();
  });

  it('does not block a different provider', () => {
    const a = acquireProviderLock(7, 'sync');
    const b = acquireProviderLock(8, 'sync');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a.release();
    b.release();
  });

  it('takes over a lock left behind by a dead worker', () => {
    memDb.prepare(`INSERT INTO provider_locks (provider_id, operation, owner_pid, owner_token, acquired_at, expires_at)
                   VALUES (7, 'sync', 999999, 'stale', 1, 2)`).run();
    const taken = acquireProviderLock(7, 'sync');
    expect(taken).not.toBeNull();
    taken.release();
  });

  it('makes performSync skip a provider that is already being worked on', async () => {
    const held = acquireProviderLock(7, 'delete');
    try {
      const result = await performSync(7, 1, { mode: 'manual' });
      expect(result.status).toBe('locked');
      expect(result.errorMessage).toMatch(/already being deleted/i);
      // Nothing must be logged for a run that never started.
      expect(memDb.prepare('SELECT COUNT(*) c FROM sync_logs').get().c).toBe(0);
    } finally {
      held.release();
    }
  });

  it('answers 409 when a provider is deleted while its sync holds the lock', () => {
    const held = acquireProviderLock(7, 'sync');
    try {
      const res = resDouble();
      deleteProvider({ params: { id: '7' }, user: { is_admin: 1 } }, res);
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toMatch(/synchronized/i);
      expect(memDb.prepare('SELECT COUNT(*) c FROM providers WHERE id = 7').get().c).toBe(1);
    } finally {
      held.release();
    }
  });

  it('fails closed when the lock table itself is contended', async () => {
    // SQLITE_BUSY during acquisition happens exactly while a long write is in
    // progress — the situation the lock exists for. Degrading to a no-op lock
    // there would permit the overlap it has to prevent.
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      if (/INSERT INTO provider_locks/i.test(sql)) {
        return { run: () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; } };
      }
      return original(sql);
    });
    try {
      expect(acquireProviderLock(7, 'sync')).toBeNull();

      const result = await performSync(7, 1, { mode: 'manual' });
      expect(result.status).toBe('locked');
      expect(memDb.prepare('SELECT COUNT(*) c FROM sync_logs').get().c).toBe(0);

      const res = resDouble();
      deleteProvider({ params: { id: '7' }, user: { is_admin: 1 } }, res);
      expect(res.statusCode).toBe(409);
      expect(memDb.prepare('SELECT COUNT(*) c FROM providers WHERE id = 7').get().c).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails closed when the lock-table probe is refused by the database', async () => {
    // A transient SQLITE_BUSY on the CREATE TABLE probe must not mark the whole
    // worker as "locks unavailable" for the rest of its life.
    resetProviderLockState();
    const busy = () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; };
    const execSpy = vi.spyOn(memDb, 'exec').mockImplementation(busy);
    try {
      expect(acquireProviderLock(7, 'sync')).toBeNull();

      const result = await performSync(7, 1, { mode: 'manual' });
      expect(result.status).toBe('locked');

      const res = resDouble();
      deleteProvider({ params: { id: '7' }, user: { is_admin: 1 } }, res);
      expect(res.statusCode).toBe(409);
      expect(memDb.prepare('SELECT COUNT(*) c FROM providers WHERE id = 7').get().c).toBe(1);
    } finally {
      execSpy.mockRestore();
    }

    // The refusal was not cached: once the database answers again, locks work.
    const recovered = acquireProviderLock(7, 'sync');
    expect(recovered).not.toBeNull();
    recovered.release();
  });

  it('still degrades for a connection that cannot be a SQLite database', () => {
    resetProviderLockState();
    const execSpy = vi.spyOn(memDb, 'exec').mockImplementation(() => { throw new TypeError('db.exec is not a function'); });
    try {
      const lock = acquireProviderLock(7, 'sync');
      expect(lock).not.toBeNull();
      expect(lock.degraded).toBe(true);
    } finally {
      execSpy.mockRestore();
      resetProviderLockState();
    }
  });

  it('keeps a lock another process still holds when the primary starts', () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = memDb.prepare(`INSERT INTO provider_locks
      (provider_id, operation, owner_pid, owner_token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(7, 'sync', 424242, 'other-process', now - 60, now + 600);   // still leased
    insert.run(8, 'sync', 424242, 'expired', now - 4000, now - 10);        // lease ran out

    expect(clearExpiredProviderLocks(now)).toBe(1);
    expect(describeProviderLock(7)?.owner_pid).toBe(424242);
    expect(describeProviderLock(8)).toBeNull();

    // And the surviving lock still blocks this process.
    expect(acquireProviderLock(7, 'sync')).toBeNull();
  });

  it('rejects a non-admin deletion before it can touch the lock table', () => {
    // Lock acquisition is a synchronous SQLite write. Reaching it without
    // authorization lets anyone block a worker for the busy timeout and briefly
    // hold a real deletion lock, which answers legitimate requests with 409.
    const statements = [];
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      statements.push(sql);
      return original(sql);
    });

    const res = resDouble();
    try {
      deleteProvider({ params: { id: '7' }, user: { is_admin: 0 } }, res);
    } finally {
      spy.mockRestore();
    }

    expect(res.statusCode).toBe(403);
    expect(statements.some(sql => /provider_locks/i.test(sql))).toBe(false);
    expect(memDb.prepare('SELECT COUNT(*) c FROM provider_locks').get().c).toBe(0);
    expect(memDb.prepare('SELECT COUNT(*) c FROM providers WHERE id = 7').get().c).toBe(1);
  });

  it('rejects an unusable provider id before touching the lock table', () => {
    const res = resDouble();
    deleteProvider({ params: { id: 'not-a-number' }, user: { is_admin: 1 } }, res);
    expect(res.statusCode).toBe(400);
    expect(memDb.prepare('SELECT COUNT(*) c FROM provider_locks').get().c).toBe(0);
  });

  it('releases the lock again after a completed run', async () => {
    const result = await performSync(7, 1, { mode: 'manual' });
    expect(result.status).not.toBe('locked');
    expect(describeProviderLock(7)).toBeNull();
  });
});
