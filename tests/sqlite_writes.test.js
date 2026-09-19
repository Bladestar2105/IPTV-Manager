import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteConnection } from '../src/database/sqliteConnection.js';
import {
  immediateTransaction, isRetryableSqliteError, runWriteWithRetry,
} from '../src/database/sqliteWrites.js';

const dirs = [];
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-sqlite-writes-'));
  dirs.push(dir);
  const file = join(dir, 'db.sqlite');
  const setup = openSqliteConnection(file);
  setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t VALUES (1, 0), (2, 0);');
  setup.close();
  return file;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('isRetryableSqliteError', () => {
  it('recognises the lock-contention codes only', () => {
    expect(isRetryableSqliteError({ code: 'SQLITE_BUSY' })).toBe(true);
    expect(isRetryableSqliteError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
    expect(isRetryableSqliteError({ code: 'SQLITE_LOCKED' })).toBe(true);
    expect(isRetryableSqliteError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false);
    expect(isRetryableSqliteError(new Error('boom'))).toBe(false);
    expect(isRetryableSqliteError(null)).toBe(false);
  });
});

describe('immediateTransaction', () => {
  it('survives a concurrent commit between its read and its write', () => {
    const file = tempDb();
    const worker = openSqliteConnection(file);
    const intruder = openSqliteConnection(file);
    try {
      // A deferred transaction takes its read snapshot at the first SELECT and
      // only then asks for the write lock, so this shape fails.
      const deferred = worker.transaction(() => {
        worker.prepare('SELECT v FROM t WHERE id = 1').get();
        intruder.prepare('UPDATE t SET v = v + 1 WHERE id = 2').run();
        worker.prepare('UPDATE t SET v = v + 1 WHERE id = 1').run();
      });
      expect(() => deferred()).toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY_SNAPSHOT' }));

      const immediate = immediateTransaction(worker, () => {
        worker.prepare('SELECT v FROM t WHERE id = 1').get();
        worker.prepare('UPDATE t SET v = v + 1 WHERE id = 1').run();
      });
      expect(() => immediate()).not.toThrow();
      expect(worker.prepare('SELECT v FROM t WHERE id = 1').get().v).toBe(1);
    } finally {
      worker.close();
      intruder.close();
    }
  });

  it('falls back to the plain transaction on a connection without modes', () => {
    const fake = { transaction: fn => (...args) => fn(...args) };
    const run = immediateTransaction(fake, value => value * 2);
    expect(run(21)).toBe(42);
  });

  it('passes arguments through', () => {
    const file = tempDb();
    const db = openSqliteConnection(file);
    try {
      const write = immediateTransaction(db, (id, value) => {
        db.prepare('UPDATE t SET v = ? WHERE id = ?').run(value, id);
      });
      write(2, 7);
      expect(db.prepare('SELECT v FROM t WHERE id = 2').get().v).toBe(7);
    } finally {
      db.close();
    }
  });
});

describe('runWriteWithRetry', () => {
  it('repeats a contended write and returns the successful result', async () => {
    const operation = vi.fn()
      .mockImplementationOnce(() => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY_SNAPSHOT'; throw e; })
      .mockImplementationOnce(() => 'written');

    await expect(runWriteWithRetry(operation, { baseDelayMs: 0 })).resolves.toBe('written');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const operation = vi.fn(() => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; });
    await expect(runWriteWithRetry(operation, { attempts: 3, baseDelayMs: 0 }))
      .rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('never retries an error that a repeat cannot fix', async () => {
    const operation = vi.fn(() => { const e = new Error('FOREIGN KEY constraint failed'); e.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'; throw e; });
    await expect(runWriteWithRetry(operation, { baseDelayMs: 0 }))
      .rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('immediateTransaction nesting', () => {
  it('refuses to run inside another transaction', () => {
    // better-sqlite3 turns a nested transaction into a SAVEPOINT and discards
    // its BEGIN, so `.immediate` silently becomes the deferred BEGIN of the
    // outer one — exactly the SQLITE_BUSY_SNAPSHOT this helper prevents.
    const database = openSqliteConnection(tempDb());
    try {
      const bump = immediateTransaction(database, () => database.prepare('UPDATE t SET v = v + 1 WHERE id = 1').run());
      bump();
      expect(database.prepare('SELECT v FROM t WHERE id = 1').get().v).toBe(1);

      const outer = database.transaction(() => bump());
      expect(() => outer()).toThrow(/cannot run inside another transaction/);
      expect(database.prepare('SELECT v FROM t WHERE id = 1').get().v).toBe(1);
    } finally {
      database.close();
    }
  });

  it('still falls back for a connection that does not expose the mode', () => {
    const calls = [];
    const double = { transaction: fn => { const wrapped = (...a) => { calls.push('ran'); return fn(...a); }; return wrapped; } };
    immediateTransaction(double, () => 'ok')();
    expect(calls).toEqual(['ran']);
  });
});

describe('runWriteWithRetry backoff timer', () => {
  it('keeps the process alive until the retry has settled', () => {
    // The backoff timer was unref'd, so Node could exit with the retry still
    // pending: the write was silently dropped and the awaited promise never
    // settled. A test runner keeps its own event loop alive, so this has to run
    // in a process of its own — which is also the situation that shows it.
    const helpers = fileURLToPath(new URL('../src/database/sqliteWrites.js', import.meta.url));
    const script = `
      import { runWriteWithRetry } from ${JSON.stringify(helpers)};
      let calls = 0;
      const operation = () => {
        calls++;
        if (calls < 3) { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; }
        return 'written';
      };
      const result = await runWriteWithRetry(operation, { baseDelayMs: 20 });
      console.log(JSON.stringify({ result, calls }));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 20000,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toMatch(/unsettled top-level await/);
    expect(JSON.parse(run.stdout.trim().split('\n').pop())).toEqual({ result: 'written', calls: 3 });
  }, 30000);
});
