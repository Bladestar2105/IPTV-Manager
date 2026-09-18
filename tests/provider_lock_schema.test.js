import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteConnection } from '../src/database/sqliteConnection.js';
import { migrateProviderLockTable, sweepExpiredProviderLocks } from '../src/database/providerLockSchema.js';

const dirs = [];
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-lock-schema-'));
  dirs.push(dir);
  return openSqliteConnection(join(dir, 'db.sqlite'));
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const V1 = `CREATE TABLE provider_locks (
  provider_id INTEGER PRIMARY KEY, operation TEXT NOT NULL, owner_pid INTEGER NOT NULL,
  owner_token TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`;

const V2 = `CREATE TABLE provider_locks_v2 (
  lock_key TEXT PRIMARY KEY, operation TEXT NOT NULL, owner_pid INTEGER NOT NULL,
  owner_token TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`;

const keys = db => db.prepare('SELECT lock_key FROM provider_locks ORDER BY lock_key').all().map(r => r.lock_key);
const tables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'provider_locks%'")
  .all().map(r => r.name).sort();

describe('migrateProviderLockTable', () => {
  it('creates the table on a fresh database', () => {
    const db = open();
    try {
      expect(migrateProviderLockTable(db)).toBe(0);
      expect(tables(db)).toEqual(['provider_locks']);
      expect(keys(db)).toEqual([]);
    } finally { db.close(); }
  });

  it('carries live leases over from the provider_id shape', () => {
    const db = open();
    try {
      db.exec(V1);
      db.prepare('INSERT INTO provider_locks VALUES (?, ?, ?, ?, ?, ?)').run(7, 'sync', 99, 'tok', 1, 9999999999);

      expect(migrateProviderLockTable(db)).toBe(1);

      expect(tables(db)).toEqual(['provider_locks']);
      expect(keys(db)).toEqual(['provider:7']);
    } finally { db.close(); }
  });

  it('is a no-op once the table already has the current shape', () => {
    const db = open();
    try {
      migrateProviderLockTable(db);
      db.prepare('INSERT INTO provider_locks VALUES (?, ?, ?, ?, ?, ?)')
        .run('source:http://p', 'episodes', 1, 't', 1, 9999999999);

      expect(migrateProviderLockTable(db)).toBe(0);
      expect(keys(db)).toEqual(['source:http://p']);
    } finally { db.close(); }
  });

  it('rescues leases stranded in provider_locks_v2 by an interrupted run', () => {
    // The migration used to be a multi-statement exec, which is not a
    // transaction: an interrupted run left only provider_locks_v2 behind, the
    // next start created an empty provider_locks, saw the current shape and
    // skipped the migration — stranding the leases in an orphan table for good.
    const db = open();
    try {
      db.exec(V2);
      db.prepare('INSERT INTO provider_locks_v2 VALUES (?, ?, ?, ?, ?, ?)')
        .run('provider:3', 'delete', 42, 'tok', 1, 9999999999);

      expect(migrateProviderLockTable(db)).toBe(1);

      expect(tables(db)).toEqual(['provider_locks']);
      expect(keys(db)).toEqual(['provider:3']);
    } finally { db.close(); }
  });

  it('merges an orphan table into an already migrated one without losing either', () => {
    const db = open();
    try {
      migrateProviderLockTable(db);
      db.prepare('INSERT INTO provider_locks VALUES (?, ?, ?, ?, ?, ?)')
        .run('provider:1', 'sync', 1, 'a', 1, 9999999999);
      db.exec(V2);
      db.prepare('INSERT INTO provider_locks_v2 VALUES (?, ?, ?, ?, ?, ?)')
        .run('provider:2', 'delete', 2, 'b', 1, 9999999999);

      migrateProviderLockTable(db);

      expect(tables(db)).toEqual(['provider_locks']);
      expect(keys(db)).toEqual(['provider:1', 'provider:2']);
    } finally { db.close(); }
  });

  it('leaves nothing behind when the migration fails halfway', () => {
    // Atomicity is what keeps the state above from ever being produced again.
    const db = open();
    try {
      db.exec(V1);
      db.prepare('INSERT INTO provider_locks VALUES (?, ?, ?, ?, ?, ?)').run(7, 'sync', 99, 'tok', 1, 9999999999);

      const original = db.exec.bind(db);
      db.exec = sql => {
        if (/DROP TABLE provider_locks;/.test(sql)) throw new Error('interrupted');
        return original(sql);
      };
      expect(() => migrateProviderLockTable(db)).toThrow(/interrupted/);
      db.exec = original;

      expect(db.inTransaction).toBe(false);
      expect(tables(db)).toEqual(['provider_locks']);
      expect(db.prepare('SELECT provider_id FROM provider_locks').all()).toEqual([{ provider_id: 7 }]);
    } finally { db.close(); }
  });

  it('still works on a connection that cannot report its shape', () => {
    const statements = [];
    const double = { exec: sql => statements.push(sql) };
    expect(migrateProviderLockTable(double)).toBe(0);
    expect(statements.join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS provider_locks/);
  });
});

describe('sweepExpiredProviderLocks', () => {
  it('removes only the leases that have run out', () => {
    const db = open();
    try {
      migrateProviderLockTable(db);
      const insert = db.prepare('INSERT INTO provider_locks VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('provider:1', 'sync', 1, 'a', 1, 100);
      insert.run('provider:2', 'sync', 2, 'b', 1, 9999999999);

      expect(sweepExpiredProviderLocks(db, 500)).toBe(1);
      expect(keys(db)).toEqual(['provider:2']);
    } finally { db.close(); }
  });
});
