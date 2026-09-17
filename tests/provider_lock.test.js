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
  acquireProviderLock, describeProviderLock, clearProviderLocks, resetProviderLockState,
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

  it('releases the lock again after a completed run', async () => {
    const result = await performSync(7, 1, { mode: 'manual' });
    expect(result.status).not.toBe('locked');
    expect(describeProviderLock(7)).toBeNull();
  });
});
