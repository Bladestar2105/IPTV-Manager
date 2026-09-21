import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/database/db.js', () => ({ default: {} }));

const TTL = 300000;
const connections = [];
let directory;
let file;
let writer;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'iptv-epg-logos-'));
  file = join(directory, 'epg.db');
  writer = new Database(file);
  connections.push(writer);
  writer.pragma('journal_mode = WAL');
  writer.exec("CREATE TABLE epg_channels (id TEXT PRIMARY KEY, logo TEXT); INSERT INTO epg_channels VALUES ('news', 'old-logo')");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const connection of connections.splice(0)) {
    if (connection.inTransaction) connection.exec('ROLLBACK');
    connection.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

async function workerCache() {
  const queries = [];
  const connection = new Database(file, { verbose: sql => queries.push(sql) });
  connections.push(connection);
  vi.doMock('../src/database/epgDb.js', () => ({ default: connection }));
  // Separate module state and real connections model the independent caches of
  // HTTP workers, without replacing SQLite or its cross-connection counters.
  vi.resetModules();
  const service = await import('../src/services/logoResolver.js');
  return { connection, service, scans: () => queries.filter(sql => /FROM\s+epg_channels\b/i.test(sql)).length };
}

const expire = () => vi.setSystemTime(Date.now() + TTL + 1);

describe('EPG logo cache freshness', () => {
  it('does not rescan unchanged 33k-row catalogs in each worker every five minutes', async () => {
    const insert = writer.prepare('INSERT INTO epg_channels VALUES (?, ?)');
    writer.transaction(() => {
      for (let i = 1; i < 33331; i++) insert.run(`channel-${i}`, `logo-${i}`);
    })();
    const workers = [await workerCache(), await workerCache()];
    for (const worker of workers) expect(worker.service.loadEpgLogosCache().size).toBe(33331);

    for (let interval = 0; interval < 24; interval++) {
      expire();
      for (const worker of workers) expect(worker.service.getEpgLogo('news')).toBe('old-logo');
    }

    for (const worker of workers) expect(worker.scans()).toBe(1);
  });

  it('refreshes every worker after another connection commits changes, retaining the five-minute bound', async () => {
    const workers = [await workerCache(), await workerCache()];
    for (const worker of workers) expect(worker.service.getEpgLogo('news')).toBe('old-logo');
    writer.exec("UPDATE epg_channels SET logo = 'new-logo'; INSERT INTO epg_channels VALUES ('extra', 'extra-logo')");
    for (const worker of workers) {
      expect(worker.service.getEpgLogo('news')).toBe('old-logo');
      expect(worker.scans()).toBe(1);
    }
    expire();
    for (const worker of workers) {
      expect(worker.service.getEpgLogo('news')).toBe('new-logo');
      expect(worker.service.getEpgLogo('extra')).toBe('extra-logo');
      expect(worker.scans()).toBe(2);
    }
    writer.exec("DELETE FROM epg_channels WHERE id = 'news'");
    expire();
    for (const worker of workers) expect(worker.service.getEpgLogo('news')).toBeNull();
  });

  it('detects writes on the cache connection even though data_version does not change', async () => {
    const { connection, service } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('old-logo');
    const version = connection.pragma('data_version', { simple: true });
    connection.exec("UPDATE epg_channels SET logo = 'local-logo'");
    expect(connection.pragma('data_version', { simple: true })).toBe(version);
    expire();
    expect(service.getEpgLogo('news')).toBe('local-logo');
  });

  it('keeps explicit invalidation immediate and preserves provider-logo fallback', async () => {
    const { service, scans } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('old-logo');
    writer.exec("UPDATE epg_channels SET logo = ''");
    service.invalidateEpgLogosCache();
    expect(service.resolveChannelLogo({ providerLogo: 'provider-logo', epgChannelId: 'news', useEpgLogo: true })).toBe('provider-logo');
    expect(service.getEpgLogo('news')).toBeNull();
    expect(scans()).toBe(2);
    expire();
    expect(service.loadEpgLogosCache().size).toBe(0);
    expect(scans()).toBe(2); // An empty, unchanged cache is still a valid cache.
  });

  it('retains the last good cache after a real query error and retries the refresh', async () => {
    const { service } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('old-logo');
    writer.exec('ALTER TABLE epg_channels RENAME TO unavailable_channels');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expire();
    expect(service.getEpgLogo('news')).toBe('old-logo');
    expect(error).toHaveBeenCalled();
    writer.exec("ALTER TABLE unavailable_channels RENAME TO epg_channels; UPDATE epg_channels SET logo = 'recovered-logo'");
    expect(service.getEpgLogo('news')).toBe('recovered-logo');
  });

  it('does not retain a rolled-back logo after reading inside a transaction', async () => {
    const { connection, service } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('old-logo');
    connection.exec("BEGIN; UPDATE epg_channels SET logo = 'uncommitted-logo'");
    expire();
    expect(service.getEpgLogo('news')).toBe('uncommitted-logo');
    connection.exec('ROLLBACK');
    expire();
    expect(service.getEpgLogo('news')).toBe('old-logo');
  });
});
