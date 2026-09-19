import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { immediateTransaction } from '../src/database/sqliteWrites.js';

// better-sqlite3's db.transaction(fn) emits a plain BEGIN, which is deferred:
// the transaction takes its read snapshot at the first SELECT and only asks for
// the write lock later. If another connection commits in between, SQLite answers
// SQLITE_BUSY_SNAPSHOT — reported as "database is locked" and *not* covered by
// busy_timeout, because there is nothing to wait for.
//
// The services were moved to immediateTransaction; the controllers were not,
// and they hold twenty transactions, several of which read before they write.

const dirs = [];
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-tx-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const setup = new Database(path);
  setup.pragma('journal_mode = WAL');
  setup.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, n INTEGER)');
  setup.prepare('INSERT INTO rows (id, n) VALUES (1, 1)').run();
  setup.close();
  const make = () => {
    const db = new Database(path);
    db.pragma('busy_timeout = 300');
    return db;
  };
  return [make(), make()];
};

afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('read-then-write transactions', () => {
  it('fails with BUSY_SNAPSHOT when it starts with a deferred BEGIN', () => {
    const [a, b] = open();
    try {
      const readThenWrite = a.transaction(() => {
        const max = a.prepare('SELECT MAX(n) AS n FROM rows').get().n;
        // Another connection commits while this transaction holds only a read
        // snapshot — the ordinary case with a dozen workers.
        b.prepare('INSERT INTO rows (id, n) VALUES (2, ?)').run(max + 1);
        a.prepare('INSERT INTO rows (id, n) VALUES (3, ?)').run(max + 1);
      });

      expect(() => readThenWrite()).toThrowError(
        expect.objectContaining({ code: 'SQLITE_BUSY_SNAPSHOT' })
      );
    } finally { a.close(); b.close(); }
  });

  it('holds the write lock from the start with BEGIN IMMEDIATE', () => {
    const [a, b] = open();
    try {
      const readThenWrite = immediateTransaction(a, () => {
        const max = a.prepare('SELECT MAX(n) AS n FROM rows').get().n;
        // b cannot get in: it waits out its busy_timeout instead, and this
        // transaction commits.
        expect(() => b.prepare('INSERT INTO rows (id, n) VALUES (2, ?)').run(max + 1))
          .toThrowError(expect.objectContaining({ code: 'SQLITE_BUSY' }));
        a.prepare('INSERT INTO rows (id, n) VALUES (3, ?)').run(max + 1);
      });

      expect(() => readThenWrite()).not.toThrow();
      expect(a.prepare('SELECT COUNT(*) c FROM rows').get().c).toBe(2);
    } finally { a.close(); b.close(); }
  });
});

const CONTROLLERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers');

describe('controllers', () => {
  it('never opens a transaction with a deferred BEGIN', () => {
    const offenders = readdirSync(CONTROLLERS, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
      .flatMap(entry => {
        const file = join(CONTROLLERS, entry.name);
        return readFileSync(file, 'utf8').split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => /\b\w*[Dd]b\.transaction\s*\(/.test(line))
          .map(({ line, index }) => `${entry.name}:${index + 1} — ${line.trim().slice(0, 100)}`);
      });

    expect(offenders).toEqual([]);
  });
});
