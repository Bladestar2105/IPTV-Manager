import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openSqliteConnection,
  resolveBusyTimeoutMs,
  resolveJournalSizeLimit,
} from '../src/database/sqliteConnection.js';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-sqlite-conn-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('resolveBusyTimeoutMs', () => {
  it('defaults to 30s so a writer outlasts a long catalog transaction', () => {
    expect(resolveBusyTimeoutMs(undefined)).toBe(30000);
    expect(resolveBusyTimeoutMs('')).toBe(30000);
    expect(resolveBusyTimeoutMs('not-a-number')).toBe(30000);
    expect(resolveBusyTimeoutMs('0')).toBe(30000);
  });

  it('accepts an override and clamps it to a sane range', () => {
    expect(resolveBusyTimeoutMs('45000')).toBe(45000);
    expect(resolveBusyTimeoutMs('10')).toBe(1000);
    expect(resolveBusyTimeoutMs('999999999')).toBe(300000);
  });
});

describe('resolveJournalSizeLimit', () => {
  it('caps the WAL so a checkpointed journal shrinks again', () => {
    expect(resolveJournalSizeLimit(undefined)).toBe(64 * 1024 * 1024);
    expect(resolveJournalSizeLimit('8388608')).toBe(8388608);
    expect(resolveJournalSizeLimit('1024')).toBe(1024 * 1024);
  });
});

describe('openSqliteConnection', () => {
  it('applies busy_timeout, foreign keys, WAL and the journal size limit', () => {
    const file = join(tempDir(), 'db.sqlite');
    const db = openSqliteConnection(file);
    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(30000);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('journal_size_limit', { simple: true })).toBe(64 * 1024 * 1024);
    } finally {
      db.close();
    }
  });

  it('can disable foreign keys without losing the shared lock wait', () => {
    const file = join(tempDir(), 'db.sqlite');
    const db = openSqliteConnection(file, { foreignKeys: false });
    try {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
      // Regression: the EPG import connections used `new Database(path)` and
      // therefore ran with busy_timeout = 0, failing on the first collision.
      expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('waits for a concurrent writer instead of failing immediately', () => {
    const dir = tempDir();
    const file = join(dir, 'db.sqlite');
    const setup = openSqliteConnection(file);
    setup.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t VALUES (1, 0);');
    setup.close();

    // A second process holds the write lock for 1.5s; better-sqlite3 is
    // synchronous, so the competing writer has to live outside this process.
    const holder = join(dir, 'holder.cjs');
    writeFileSync(holder, `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(${JSON.stringify(file)});
      db.pragma('busy_timeout = 30000');
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE t SET v = 1 WHERE id = 1').run();
      process.send ? process.send('locked') : console.log('locked');
      const until = Date.now() + 1500;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, until - Date.now());
      db.exec('COMMIT');
    `);

    // The wrapper returns as soon as the holder reports that it owns the lock,
    // so the competing write below starts while the lock is still held.
    const runner = join(dir, 'runner.cjs');
    writeFileSync(runner, `
      const cp = require('child_process');
      const child = cp.spawn(process.execPath, [${JSON.stringify(holder)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => { child.unref(); process.exit(0); });
    `);
    execFileSync(process.execPath, [runner], { stdio: 'ignore' });

    const writer = openSqliteConnection(file);
    const started = Date.now();
    try {
      writer.prepare('UPDATE t SET v = 2 WHERE id = 1').run();
    } finally {
      writer.close();
    }
    const waited = Date.now() - started;
    // It had to wait for the holder; with busy_timeout = 0 this would have
    // thrown SQLITE_BUSY straight away instead of blocking for ~1.5s.
    expect(waited).toBeGreaterThan(500);
  }, 20000);
});
