import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

// The provider fallback path — a provider with epg_enabled but no epg_url —
// replaces its EPG channels from the local catalog. It used to do that as two
// autocommitted deletes followed by a separate insert transaction, so an insert
// that failed for any reason left the provider with no EPG channels at all until
// the next daily run happened to succeed.

// Declared normally, not via vi.hoisted: the mock factories below are hoisted as
// calls but only run when the module under test is imported, which is after this.
const mainDb = new Database(':memory:');
const epgDb = new Database(':memory:');
const failure = { afterRows: null };

vi.mock('../../src/database/db.js', () => ({ default: mainDb }));
vi.mock('../../src/database/epgDb.js', () => ({ default: epgDb, initEpgDb: () => {} }));
vi.mock('../../src/services/logoResolver.js', () => ({ invalidateEpgLogosCache: vi.fn() }));
vi.mock('../../src/services/epgImportService.js', () => ({
  importEpgFromUrl: vi.fn(), dropOrphanedStagingTables: vi.fn(),
}));
// The import opens its own connection; hand it the same in-memory database so
// the assertions below see what it wrote, and let a test make its insert fail.
vi.mock('../../src/database/sqliteConnection.js', async importOriginal => ({
  ...(await importOriginal()),
  openSqliteConnection: () => new Proxy(epgDb, {
    get(target, prop) {
      if (prop === 'close') return () => {};
      if (prop === 'prepare') {
        return sql => {
          const statement = target.prepare(sql);
          if (!/INSERT OR REPLACE INTO epg_channels/i.test(sql)) return statement;
          let rows = 0;
          return new Proxy(statement, {
            get(stmt, key) {
              if (key !== 'run') {
                const value = stmt[key];
                return typeof value === 'function' ? value.bind(stmt) : value;
              }
              return (...args) => {
                if (failure.afterRows !== null && rows >= failure.afterRows) {
                  throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
                }
                rows++;
                return stmt.run(...args);
              };
            },
          });
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
}));

const { updateProviderEpg } = await import('../../src/services/epgService.js');

mainDb.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT, epg_enabled INTEGER, epg_url TEXT, last_epg_update INTEGER);
  CREATE TABLE provider_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER, epg_channel_id TEXT, name TEXT, logo TEXT
  );
`);
epgDb.exec(`
  CREATE TABLE epg_channels (
    id TEXT NOT NULL, name TEXT, logo TEXT, source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY (id, source_type, source_id)
  );
  CREATE TABLE epg_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT, source_type TEXT, source_id INTEGER,
    start INTEGER, stop INTEGER, title TEXT
  );
`);

const channelIds = () => epgDb.prepare(
  "SELECT id FROM epg_channels WHERE source_type = 'provider' AND source_id = 1 ORDER BY id"
).all().map(row => row.id);

describe('provider EPG channel import', () => {
  beforeEach(() => {
    failure.afterRows = null;
    mainDb.prepare('DELETE FROM provider_channels').run();
    mainDb.prepare('DELETE FROM providers').run();
    epgDb.prepare('DELETE FROM epg_channels').run();
    epgDb.prepare('DELETE FROM epg_programs').run();

    mainDb.prepare('INSERT INTO providers (id, name, epg_enabled, epg_url) VALUES (1, ?, 1, ?)').run('p', '');
    const insert = mainDb.prepare('INSERT INTO provider_channels (provider_id, epg_channel_id, name, logo) VALUES (1, ?, ?, ?)');
    for (let i = 1; i <= 4; i++) insert.run(`ch${i}`, `Channel ${i}`, `logo${i}.png`);
  });

  afterAll(() => { mainDb.close(); epgDb.close(); });

  it('replaces the channels of the provider', async () => {
    await updateProviderEpg(1, true);
    expect(channelIds()).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
  });

  it('keeps the previous channels when the refill fails part-way', async () => {
    await updateProviderEpg(1, true);
    epgDb.prepare("INSERT INTO epg_programs (channel_id, source_type, source_id, start, stop, title) VALUES ('ch1', 'provider', 1, 0, 1, 't')").run();
    expect(channelIds()).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);

    // The clear ran, then the refill died on the third row.
    failure.afterRows = 2;
    await expect(updateProviderEpg(1, true)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });

    expect(channelIds()).toEqual(['ch1', 'ch2', 'ch3', 'ch4']);
    expect(epgDb.prepare("SELECT COUNT(*) c FROM epg_programs WHERE source_id = 1").get().c).toBe(1);
  });

  it('leaves another provider alone', async () => {
    epgDb.prepare(`INSERT INTO epg_channels (id, name, source_type, source_id, updated_at)
                   VALUES ('other', 'Other', 'provider', 2, 0)`).run();

    await updateProviderEpg(1, true);

    expect(epgDb.prepare("SELECT COUNT(*) c FROM epg_channels WHERE source_id = 2").get().c).toBe(1);
  });
});
