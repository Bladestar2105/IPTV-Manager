import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { deleteInBatches } from '../src/database/sqliteWrites.js';

// A retention sweep deletes whatever accumulated since it last ran, and it last
// ran whenever the process that owns it happened to stay up long enough — so
// one `DELETE ... WHERE ts < ?` holds the write lock for a length nobody can
// predict from the code. These sweeps run in a worker that is also pumping
// streams, and better-sqlite3 blocks its event loop for the duration.

const databases = [];
const open = rows => {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER)');
  const insert = db.prepare('INSERT INTO logs (timestamp) VALUES (?)');
  db.transaction(() => { for (const ts of rows) insert.run(ts); })();
  return db;
};
const remaining = db => db.prepare('SELECT COUNT(*) c FROM logs').get().c;

afterEach(() => { while (databases.length) databases.pop().close(); });

describe('deleteInBatches', () => {
  it('removes every matching row across several batches', () => {
    const db = open([...Array(250).keys()].map(i => i));

    expect(deleteInBatches(db, 'logs', 'timestamp < ?', [200], { batchSize: 40 })).toBe(200);
    expect(remaining(db)).toBe(50);
  });

  it('leaves rows that do not match', () => {
    const db = open([1, 2, 3, 500, 600]);

    expect(deleteInBatches(db, 'logs', 'timestamp < ?', [100], { batchSize: 2 })).toBe(3);
    expect(db.prepare('SELECT timestamp FROM logs ORDER BY timestamp').all())
      .toEqual([{ timestamp: 500 }, { timestamp: 600 }]);
  });

  it('commits each batch on its own, so a failure keeps what was already done', () => {
    const db = open([...Array(100).keys()].map(i => i));
    let runs = 0;
    const prepared = db.prepare.bind(db);
    db.prepare = sql => {
      const statement = prepared(sql);
      if (!/DELETE FROM logs/.test(sql)) return statement;
      const run = statement.run.bind(statement);
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'run') {
            return (...args) => {
              if (++runs === 3) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
              return run(...args);
            };
          }
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    expect(() => deleteInBatches(db, 'logs', 'timestamp < ?', [100], { batchSize: 10 })).toThrow(/locked/);
    db.prepare = prepared;

    // Two batches are gone, the failing one rolled back, nothing is half-done.
    expect(remaining(db)).toBe(80);
    expect(db.inTransaction).toBe(false);
  });

  it('stops rather than looping forever', () => {
    const db = open([...Array(100).keys()].map(i => i));

    expect(deleteInBatches(db, 'logs', 'timestamp < ?', [100], { batchSize: 10, maxBatches: 3 })).toBe(30);
    expect(remaining(db)).toBe(70);
  });

  it('is a cheap no-op when there is nothing to remove', () => {
    const db = open([500, 600]);

    expect(deleteInBatches(db, 'logs', 'timestamp < ?', [100])).toBe(0);
    expect(remaining(db)).toBe(2);
  });
});
