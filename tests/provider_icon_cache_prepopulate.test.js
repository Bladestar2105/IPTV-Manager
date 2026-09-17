import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));

const { prePopulateProviderIconCache, getLogoCacheHash, clearProviderIconCache } =
  await import('../src/services/logoResolver.js');

memDb.exec(`
  CREATE TABLE provider_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL, logo TEXT
  );
  CREATE TABLE provider_icon_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL, logo_url TEXT NOT NULL,
    cache_hash TEXT NOT NULL, created_at INTEGER DEFAULT 0, last_accessed INTEGER DEFAULT 0,
    access_count INTEGER DEFAULT 0, UNIQUE(provider_id, logo_url)
  );
`);

const insertChannel = memDb.prepare('INSERT INTO provider_channels (provider_id, logo) VALUES (?, ?)');
const cacheRows = () => memDb.prepare('SELECT COUNT(*) c FROM provider_icon_cache').get().c;

function countInserts(fn) {
  let inserts = 0;
  const original = memDb.prepare.bind(memDb);
  const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
    const statement = original(sql);
    if (/INSERT\s+OR\s+IGNORE\s+INTO\s+provider_icon_cache/i.test(sql)) {
      const run = statement.run.bind(statement);
      return new Proxy(statement, {
        get(target, prop) {
          if (prop === 'run') return (...args) => { inserts++; return run(...args); };
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    return statement;
  });
  try { fn(); } finally { spy.mockRestore(); }
  return inserts;
}

describe('prePopulateProviderIconCache', () => {
  beforeEach(() => {
    memDb.prepare('DELETE FROM provider_channels').run();
    memDb.prepare('DELETE FROM provider_icon_cache').run();
    clearProviderIconCache(1);
  });

  afterAll(() => memDb.close());

  it('caches every distinct logo on the first run', () => {
    for (let i = 0; i < 50; i++) insertChannel.run(1, `http://cdn.example/logo-${i}.png`);
    insertChannel.run(1, '');
    insertChannel.run(1, null);

    const inserts = countInserts(() => prePopulateProviderIconCache(1));
    expect(inserts).toBe(50);
    expect(cacheRows()).toBe(50);
  });

  it('writes nothing when the catalog is unchanged', () => {
    for (let i = 0; i < 50; i++) insertChannel.run(1, `http://cdn.example/logo-${i}.png`);
    prePopulateProviderIconCache(1);

    // Regression: every sync re-ran INSERT OR IGNORE for each logo, which meant
    // a six-figure statement count and a multi-second write transaction even
    // when nothing had changed upstream.
    const inserts = countInserts(() => prePopulateProviderIconCache(1));
    expect(inserts).toBe(0);
    expect(cacheRows()).toBe(50);
  });

  it('writes only the logos that are new', () => {
    for (let i = 0; i < 50; i++) insertChannel.run(1, `http://cdn.example/logo-${i}.png`);
    prePopulateProviderIconCache(1);

    insertChannel.run(1, 'http://cdn.example/logo-new-a.png');
    insertChannel.run(1, 'http://cdn.example/logo-new-b.png');
    const inserts = countInserts(() => prePopulateProviderIconCache(1));
    expect(inserts).toBe(2);
    expect(cacheRows()).toBe(52);
  });

  it('keeps the hash of every current logo available for lookups', () => {
    insertChannel.run(1, 'http://cdn.example/only.png');
    prePopulateProviderIconCache(1);
    const row = memDb.prepare('SELECT cache_hash FROM provider_icon_cache WHERE provider_id = 1').get();
    expect(row.cache_hash).toBe(getLogoCacheHash('http://cdn.example/only.png'));
  });
});
