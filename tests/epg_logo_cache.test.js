import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mainDb } = vi.hoisted(() => ({ mainDb: { prepare: vi.fn() } }));
vi.mock('../src/database/db.js', () => ({ default: mainDb }));

const TTL = 300000;
const connections = [];
let directory;
let file;
let writer;

beforeEach(() => {
  mainDb.prepare.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'iptv-epg-logos-'));
  file = join(directory, 'epg.db');
  writer = new Database(file);
  connections.push(writer);
  writer.pragma('journal_mode = WAL');
  writer.exec("CREATE TABLE epg_channels (id TEXT, logo TEXT, source_type TEXT DEFAULT 'custom', source_id INTEGER DEFAULT 1, PRIMARY KEY (id, source_type, source_id)); INSERT INTO epg_channels (id, logo) VALUES ('news', 'old-logo')");
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
    const insert = writer.prepare('INSERT INTO epg_channels (id, logo) VALUES (?, ?)');
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
    writer.exec("UPDATE epg_channels SET logo = 'new-logo'; INSERT INTO epg_channels (id, logo) VALUES ('extra', 'extra-logo')");
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

  it('resolves relative and protocol-relative EPG icons from fresh source URLs', async () => {
    writer.exec("UPDATE epg_channels SET logo = 'icons/news.png'");
    let base = 'https://epg.test/feed/guide.xml';
    mainDb.prepare.mockImplementation(() => ({ get: () => ({ url: base }) }));
    const { service, scans } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('icons/news.png');
    expect(service.loadEpgLogosCache().get('news')).toBe('icons/news.png');
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://epg.test/feed/icons/news.png');
    base = 'http://changed-epg.test/other/guide.xml';
    expect(service.getEpgLogo('news', { absolute: true })).toBe('http://changed-epg.test/other/icons/news.png');
    expect(scans()).toBe(1);
    writer.exec("UPDATE epg_channels SET logo = '//cdn.test/icon.png'");
    service.invalidateEpgLogosCache();
    expect(service.getEpgLogo('news', { absolute: true })).toBe('http://cdn.test/icon.png');
  });

  it('keeps the winning duplicate logo tied to its own source and supports provider bases', async () => {
    writer.exec("UPDATE epg_channels SET logo = 'provider-logo.png'; INSERT INTO epg_channels (id, logo, source_type, source_id) VALUES ('news', 'provider-logo.png', 'provider', 9)");
    const sourceDb = new Database(':memory:');
    connections.push(sourceDb);
    sourceDb.exec("CREATE TABLE epg_sources (id INTEGER, url TEXT); INSERT INTO epg_sources VALUES (1, 'https://custom.test/guide.xml'); CREATE TABLE providers (id INTEGER, url TEXT, epg_url TEXT); INSERT INTO providers VALUES (9, 'http://provider.test/list.m3u', 'https://provider-epg.test/feed/guide.xml')");
    mainDb.prepare.mockImplementation(sql => sourceDb.prepare(sql));
    const { service } = await workerCache();
    expect(service.getEpgLogo('news')).toBe('provider-logo.png');
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://provider-epg.test/feed/provider-logo.png');
    sourceDb.exec("UPDATE providers SET epg_url = '  '");
    expect(service.getEpgLogo('news', { absolute: true })).toBe('http://provider.test/provider-logo.png');
  });

  it('does not retain source provenance read from a rolled-back transaction', async () => {
    writer.exec("UPDATE epg_channels SET logo = 'icon.png'");
    mainDb.prepare.mockImplementation(() => ({ get: id => ({ url: `https://epg.test/${id}/guide.xml` }) }));
    const { connection, service } = await workerCache();
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://epg.test/1/icon.png');
    connection.exec('BEGIN; UPDATE epg_channels SET source_id = 2');
    expire();
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://epg.test/2/icon.png');
    connection.exec('ROLLBACK');
    expire();
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://epg.test/1/icon.png');
  });

  it('returns null for unavailable origins or unsupported icon schemes in absolute mode', async () => {
    const { service } = await workerCache();
    mainDb.prepare.mockReturnValue({ get: () => undefined });
    expect(service.getEpgLogo('news', { absolute: true })).toBeNull();
    writer.exec("UPDATE epg_channels SET logo = 'javascript:alert(1)'");
    service.invalidateEpgLogosCache();
    expect(service.getEpgLogo('news', { absolute: true })).toBeNull();
    writer.exec("UPDATE epg_channels SET logo = 'https://cdn.test/icon.png'");
    service.invalidateEpgLogosCache();
    expect(service.getEpgLogo('news', { absolute: true })).toBe('https://cdn.test/icon.png');
  });

});
