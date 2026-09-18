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

  it('drops cache rows for logos the catalog no longer carries', () => {
    // Rows were only ever removed with the whole provider, so a churning VOD
    // catalog left the table holding every logo the provider ever had — and the
    // diff read above then grows with the provider's history, not its catalog.
    for (let i = 0; i < 10; i++) insertChannel.run(1, `http://cdn.example/logo-${i}.png`);
    prePopulateProviderIconCache(1);
    expect(cacheRows()).toBe(10);

    memDb.prepare("DELETE FROM provider_channels WHERE logo LIKE '%logo-9.png'").run();
    insertChannel.run(1, 'http://cdn.example/fresh.png');
    prePopulateProviderIconCache(1);

    expect(cacheRows()).toBe(10);
    expect(memDb.prepare("SELECT COUNT(*) c FROM provider_icon_cache WHERE logo_url LIKE '%logo-9.png'").get().c).toBe(0);
    expect(memDb.prepare("SELECT COUNT(*) c FROM provider_icon_cache WHERE logo_url LIKE '%fresh.png'").get().c).toBe(1);
  });

  it('clears a large backlog in short batches, not one long write', () => {
    // The first run after the prune shipped has a backlog — 94,972 rows for the
    // worst provider on the affected deployment. Deleting that in one
    // transaction would hold the write lock for exactly the kind of stall this
    // work exists to remove, and asking SQLite which rows are stale cost 807ms
    // of scanning inside that transaction.
    for (let i = 0; i < 1500; i++) insertChannel.run(1, `http://cdn.example/logo-${i}.png`);
    prePopulateProviderIconCache(1);
    expect(cacheRows()).toBe(1500);

    memDb.prepare("DELETE FROM provider_channels WHERE provider_id = 1").run();
    insertChannel.run(1, 'http://cdn.example/only.png');

    const statements = [];
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => { statements.push(sql); return original(sql); });
    try {
      prePopulateProviderIconCache(1);
    } finally {
      spy.mockRestore();
    }

    expect(cacheRows()).toBe(1);
    const deletes = statements.filter(sql => /DELETE FROM provider_icon_cache/i.test(sql));
    expect(deletes.length).toBeGreaterThan(1);
    // No statement carries a six-figure parameter list, and none asks SQLite to
    // work out staleness for itself.
    for (const sql of deletes) {
      expect((sql.match(/\?/g) || []).length).toBeLessThanOrEqual(401);
      expect(sql).not.toMatch(/NOT IN/i);
    }
  });

  it('never touches another provider cache rows while pruning', () => {
    insertChannel.run(1, 'http://cdn.example/a.png');
    insertChannel.run(2, 'http://cdn.example/b.png');
    prePopulateProviderIconCache(1);
    prePopulateProviderIconCache(2);

    memDb.prepare('DELETE FROM provider_channels WHERE provider_id = 1').run();
    insertChannel.run(1, 'http://cdn.example/c.png');
    prePopulateProviderIconCache(1);

    expect(memDb.prepare('SELECT COUNT(*) c FROM provider_icon_cache WHERE provider_id = 2').get().c).toBe(1);
    expect(memDb.prepare('SELECT logo_url FROM provider_icon_cache WHERE provider_id = 1').all())
      .toEqual([{ logo_url: 'http://cdn.example/c.png' }]);
  });

  it('keeps the hash of every current logo available for lookups', () => {
    insertChannel.run(1, 'http://cdn.example/only.png');
    prePopulateProviderIconCache(1);
    const row = memDb.prepare('SELECT cache_hash FROM provider_icon_cache WHERE provider_id = 1').get();
    expect(row.cache_hash).toBe(getLogoCacheHash('http://cdn.example/only.png'));
  });

  // Splitting one write transaction into 238 also splits one chance of losing
  // the write lock into 238, and the first loss used to escape to the outer
  // catch: every remaining batch, the memory cache update and the summary line
  // were dropped, and the operator was left a bare "database is locked" — less
  // than the single transaction this replaced ever gave them.
  describe('when the write lock is lost part-way through the prune', () => {
    const stockCache = (provider, count) => {
      const insert = memDb.prepare(
        'INSERT INTO provider_icon_cache (provider_id, logo_url, cache_hash) VALUES (?, ?, ?)');
      const write = memDb.transaction(() => {
        for (let i = 0; i < count; i++) {
          insert.run(provider, `http://cdn.example/stale${i}.png`, getLogoCacheHash(`http://cdn.example/stale${i}.png`));
        }
      });
      write();
    };

    /** Fail the Nth DELETE execution with `error`. */
    const failDeleteOn = (nth, error) => {
      let seen = 0;
      const original = memDb.prepare.bind(memDb);
      return vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
        const statement = original(sql);
        if (!/DELETE\s+FROM\s+provider_icon_cache/i.test(sql)) return statement;
        const run = statement.run.bind(statement);
        return new Proxy(statement, {
          get(target, prop) {
            if (prop === 'run') {
              return (...args) => {
                seen++;
                if (seen === nth) throw error;
                return run(...args);
              };
            }
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      });
    };

    it('reports how far it got instead of reporting a failed call', () => {
      insertChannel.run(1, 'http://cdn.example/live.png');
      stockCache(1, 1000);
      const errors = [];
      const warnings = [];
      vi.spyOn(console, 'error').mockImplementation(m => errors.push(String(m)));
      vi.spyOn(console, 'warn').mockImplementation(m => warnings.push(String(m)));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const spy = failDeleteOn(2, Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));

      try {
        expect(() => prePopulateProviderIconCache(1)).not.toThrow();
      } finally {
        spy.mockRestore();
        vi.restoreAllMocks();
      }

      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/stopped at 400\/1000 stale entries/);
      expect(warnings[0]).toMatch(/SQLITE_BUSY/);
      // The batch that ran is committed; the rest is offered again next sync.
      expect(memDb.prepare('SELECT COUNT(*) c FROM provider_icon_cache WHERE provider_id = 1').get().c)
        .toBe(601);
    });

    it('still surfaces an error that is not a lost lock', () => {
      insertChannel.run(1, 'http://cdn.example/live.png');
      stockCache(1, 1000);
      const errors = [];
      vi.spyOn(console, 'error').mockImplementation(m => errors.push(String(m)));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const spy = failDeleteOn(1, Object.assign(new Error('no such column: logo_url'), { code: 'SQLITE_ERROR' }));

      try {
        prePopulateProviderIconCache(1);
      } finally {
        spy.mockRestore();
        vi.restoreAllMocks();
      }

      expect(errors.join(' ')).toMatch(/Failed to pre-populate provider icon cache/);
    });

    it('compiles the delete once per batch size, not once per batch', () => {
      insertChannel.run(1, 'http://cdn.example/live.png');
      stockCache(1, 1000);
      const compiled = [];
      const original = memDb.prepare.bind(memDb);
      const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
        if (/DELETE\s+FROM\s+provider_icon_cache/i.test(sql)) compiled.push(sql);
        return original(sql);
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      try { prePopulateProviderIconCache(1); } finally { spy.mockRestore(); vi.restoreAllMocks(); }

      // Three batches — 400, 400, 200 — but only two distinct statements.
      expect(compiled).toHaveLength(2);
      expect(memDb.prepare('SELECT COUNT(*) c FROM provider_icon_cache WHERE provider_id = 1').get().c).toBe(1);
    });
  });
});
