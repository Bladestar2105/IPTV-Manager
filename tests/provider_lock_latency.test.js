import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openSqliteConnection } from '../src/database/sqliteConnection.js';
import { migrateProviderLockTable } from '../src/database/providerLockSchema.js';

let mainDb, latencyDb, writer, directory, locks, openError;
vi.mock('../src/database/db.js', () => ({
  get default() { return mainDb; },
  openLatencyDbConnection: () => { if (openError) throw openError; return latencyDb; },
}));

beforeEach(async () => {
  openError = null;
  vi.stubEnv('SQLITE_BUSY_TIMEOUT_MS', '2000');
  vi.stubEnv('SQLITE_LATENCY_BUSY_TIMEOUT_MS', '25');
  vi.stubEnv('SYNC_MAX_CONCURRENT', '2');
  directory = mkdtempSync(join(tmpdir(), 'iptv-lock-latency-'));
  const path = join(directory, 'db.sqlite');
  mainDb = openSqliteConnection(path);
  migrateProviderLockTable(mainDb);
  latencyDb = openSqliteConnection(path, { latency: true });
  writer = openSqliteConnection(path);
  vi.resetModules();
  locks = await import('../src/services/providerLockService.js');
});

afterEach(() => {
  if (writer.inTransaction) writer.exec('ROLLBACK');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  mainDb.close();
  latencyDb.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])('fails closed promptly during a real writer transaction (warm probe: %s)', warm => {
  if (warm) {
    const lock = locks.acquireProviderLock(1, 'sync');
    lock.release();
  }
  writer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  expect(locks.acquireProviderLock(2, 'sync')).toBeNull();
  expect(locks.describeLockConflict(2)).toMatch(/busy/);
  expect(performance.now() - started).toBeLessThan(750);
  expect(writer.inTransaction).toBe(true);
  expect(mainDb.pragma('busy_timeout', { simple: true })).toBe(2000);
  writer.exec('ROLLBACK');
  const recovered = locks.acquireProviderLock(2, 'sync');
  expect(recovered).not.toBeNull();
  recovered?.release();
});

it('releases promptly under a real writer and retries after it commits', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const lock = locks.acquireProviderLock(1, 'sync');
  writer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  lock.release();
  const elapsed = performance.now() - started;
  expect(locks.describeProviderLock(1)).not.toBeNull();
  writer.exec('COMMIT');
  vi.advanceTimersByTime(1000);
  expect(locks.describeProviderLock(1)).toBeNull();
  expect(elapsed).toBeLessThan(750);
});

it('counts other connections, but not expired leases, cooldowns, deletions or source work', () => {
  const now = Math.floor(Date.now() / 1000);
  const insert = writer.prepare(`INSERT INTO provider_locks VALUES (?, ?, 999, ?, ?, ?)`);
  insert.run('provider:10', 'sync', 'other-worker', now, now + 600);
  insert.run('provider:11', 'sync', 'expired', now - 1000, now - 1);
  insert.run('provider:12', 'sync:cooldown', 'cooldown', now, now + 600);
  insert.run('provider:13', 'delete', 'delete', now, now + 600);
  insert.run('source:example', 'sync', 'source', now, now + 600);
  const admitted = locks.acquireProviderLock(1, 'sync');
  let denied, deletion;
  try {
    expect(admitted).not.toBeNull();
    denied = locks.acquireProviderLock(2, 'sync');
    expect(denied).toBeNull();
    deletion = locks.acquireProviderLock(3, 'delete');
    expect(deletion).not.toBeNull();
  } finally {
    admitted?.release();
    denied?.release();
    deletion?.release();
  }
});

it('atomically enforces the shared cap when real workers race to acquire different providers', async () => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from({ length: 4 }, (_, index) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const locks = await import(workerData.service);
      const barrier = new Int32Array(workerData.signal);
      parentPort.postMessage('ready');
      if (Atomics.wait(barrier, 0, 0, 5000) === 'timed-out') throw new Error('Missing start signal');
      const held = locks.acquireProviderLock(workerData.id, 'sync');
      parentPort.postMessage(Boolean(held));
      parentPort.once('message', () => { held?.release(); parentPort.close(); });
    })().catch(error => { throw error; });
  `, { eval: true, env: { ...process.env, DATA_DIR: directory, SYNC_MAX_CONCURRENT: '2',
    SQLITE_LATENCY_BUSY_TIMEOUT_MS: '250' }, workerData: {
    id: index + 1, signal: signal.buffer,
    service: new URL('../src/services/providerLockService.js', import.meta.url).href,
  } }));
  try {
    await Promise.all(workers.map(worker => once(worker, 'message')));
    const results = Promise.all(workers.map(worker => once(worker, 'message')));
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    const admitted = (await results).flat();
    expect(admitted.filter(Boolean)).toHaveLength(2);
    expect(writer.prepare("SELECT COUNT(*) c FROM provider_locks WHERE operation = 'sync'").get().c).toBe(2);
    const exits = Promise.all(workers.map(worker => once(worker, 'exit')));
    workers.forEach(worker => worker.postMessage('release'));
    await exits;
    expect(writer.prepare('SELECT COUNT(*) c FROM provider_locks').get().c).toBe(0);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}, 15000);

it('fails closed if opening the latency connection fails without a SQLite error code', () => {
  openError = new Error('Cannot open database because the directory does not exist');
  expect(locks.acquireProviderLock(1, 'sync')).toBeNull();
  openError = null;
  const recovered = locks.acquireProviderLock(1, 'sync');
  expect(recovered?.degraded).toBe(false);
  recovered?.release();
});
