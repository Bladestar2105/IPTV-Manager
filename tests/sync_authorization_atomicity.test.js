import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { rmSync } from 'node:fs';

const { dataDir, fetchCatalog, download } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'iptv-sync-atomic-')), fetchCatalog: vi.fn(), download: { pause: null } };
});
vi.mock('../src/config/constants.js', async original => ({ ...(await original()), DATA_DIR: dataDir }));
vi.mock('../src/services/providerCatalogSyncService.js', async original => ({
  ...(await original()), fetchProviderCatalog: fetchCatalog,
}));
vi.mock('../src/utils/network.js', async original => ({
  ...(await original()), fetchSafe: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));
vi.mock('../src/services/epgService.js', () => ({ updateProviderEpg: vi.fn(async () => {}) }));
vi.mock('../src/services/seriesSyncService.js', () => ({ syncSeriesEpisodes: vi.fn(async () => ({})) }));
vi.mock('../src/services/ai/syncHistory.js', () => ({
  captureSyncSnapshot: () => null, recordSyncSnapshot: () => [], scheduleSyncFollowups: () => {},
}));

const { default: db, initDb, DB_PATH } = await import('../src/database/db.js');
const { performSync } = await import('../src/services/syncService.js');
const { syncProvider } = await import('../src/controllers/providerController.js');
const { encrypt } = await import('../src/utils/crypto.js');
const actor = { id: 9, is_admin: true, token_version: 0 };
let writer;

beforeAll(() => { initDb(true); db.pragma('busy_timeout = 5000'); });
afterAll(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });
afterEach(async () => { vi.restoreAllMocks(); if (writer) await writer.terminate(); writer = null; });

beforeEach(() => {
  for (const table of ['sync_logs', 'user_channels', 'provider_channels', 'provider_sync_state',
    'category_mappings', 'user_categories', 'sync_configs', 'provider_locks', 'providers', 'users', 'admin_users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.exec(`
    INSERT INTO users (id, username, password) VALUES (1, 'target', 'test'), (2, 'owner', 'test');
    INSERT INTO admin_users (id, username, password, is_active, token_version) VALUES (9, 'admin', 'test', 1, 0);
    INSERT INTO providers (id, name, url, username, password, user_id)
      VALUES (7, 'provider', 'http://panel.example', 'account', 'test', 2);
    INSERT INTO sync_configs (id, provider_id, user_id, enabled, sync_interval, auto_add_channels,
      auto_add_categories, sync_series_episodes, last_sync, next_sync, granted_by_admin)
      VALUES (1, 7, 1, 1, 'daily', 1, 1, 0, 111, 222, 1);
    INSERT INTO user_categories (id, user_id, name, type, sort_order) VALUES (5, 1, 'Live', 'live', 0);
    INSERT INTO category_mappings (id, provider_id, user_id, provider_category_id,
      provider_category_name, user_category_id, auto_created, category_type)
      VALUES (1, 7, 1, 10, 'Live', 5, 0, 'live');
    INSERT INTO provider_channels (id, provider_id, remote_stream_id, name, original_category_id, stream_type)
      VALUES (20, 7, 101, 'Existing channel', 10, 'live');
    INSERT INTO user_channels (id, user_category_id, provider_channel_id, sort_order,
      assignment_origin, mapping_id, granted_by_admin, authorization_revoked, custom_name, is_hidden)
      VALUES (30, 5, 20, 8, 'mapping', 1, 1, 1, 'Keep my name', 1);
  `);
  db.prepare('UPDATE providers SET password = ? WHERE id = 7').run(encrypt('original-secret'));
  download.pause = null;
  fetchCatalog.mockImplementation(async () => {
    if (download.pause) await download.pause();
    return {
      allChannels: [101, 102].map(stream_id => ({ stream_id, name: 'Downloaded channel', category_id: 10, stream_type: 'live' })),
      allCategories: [{ category_id: 10, category_name: 'Live' }, { category_id: 99, category_name: 'New category' }],
      completeStreamTypes: new Set(['live']), snapshotStates: new Map([['live', { count: 2 }]]), failures: [],
    };
  });
});

const localState = () => Object.fromEntries(
  ['provider_channels', 'user_channels', 'category_mappings', 'user_categories', 'provider_sync_state']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
);

// A real second SQLite writer holds BEGIN IMMEDIATE before the catalog writer
// enters SQLite. It commits the mutation only AFTER that writer has started
// waiting. A worker thread is necessary: better-sqlite3 blocks the main thread.
async function holdWriterUntilApply(sql) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  writer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.sqliteModule);
    const connection = new Database(workerData.path);
    const signal = new Int32Array(workerData.signal);
    try {
      connection.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      if (Atomics.wait(signal, 0, 0, 5000) === 'timed-out') throw new Error('Catalog writer did not arrive');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      connection.exec(workerData.sql);
      connection.exec('COMMIT');
      parentPort.postMessage('committed');
    } finally { connection.close(); }
  `, { eval: true, workerData: {
    path: DB_PATH, sql, signal: signal.buffer, sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3'),
  } });
  expect((await once(writer, 'message'))[0]).toBe('locked');
  const committed = once(writer, 'message');
  let waitMs = 0;
  let signalled = false;
  const transaction = db.transaction.bind(db);
  vi.spyOn(db, 'transaction').mockImplementation(fn => {
    const wrapped = transaction(fn);
    // Forward the actual native transaction; only coordinate its entry.
    return new Proxy(function (...args) { return wrapped(...args); }, {
      get(_target, property) {
        if (property !== 'immediate') return wrapped[property];
        return (...args) => {
          if (signalled) return wrapped.immediate(...args);
          signalled = true;
          Atomics.store(signal, 0, 1);
          Atomics.notify(signal, 0);
          const started = performance.now();
          try { return wrapped.immediate(...args); }
          finally { waitMs = performance.now() - started; }
        };
      },
    });
  });
  return async () => {
    expect((await committed)[0]).toBe('committed');
    expect(signalled).toBe(true);
    expect(waitMs).toBeGreaterThanOrEqual(150);
  };
}

describe('sync authorization inside the SQLite writer transaction', () => {
  it('passes the authenticated administrator from the HTTP handler to the sync', async () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await syncProvider({ params: { id: '7' }, user: actor, body: { user_id: 1 } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, status: 'success' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(2);
  });

  it.each([
    ['scheduled grant revoked', 'UPDATE sync_configs SET granted_by_admin = 0 WHERE id = 1', { mode: 'scheduled' }],
    ['manual grant revoked', 'UPDATE sync_configs SET granted_by_admin = 0 WHERE id = 1', { mode: 'manual', actor, allowCrossOwner: true, restoreRevokedAssignments: true }],
    ['provider ownership changed', 'UPDATE providers SET user_id = 1 WHERE id = 7', { mode: 'scheduled' }],
    ['administrator disabled', 'UPDATE admin_users SET is_active = 0 WHERE id = 9', { mode: 'manual', actor, allowCrossOwner: true, restoreRevokedAssignments: true }],
    ['administrator session revoked', 'UPDATE admin_users SET token_version = 1 WHERE id = 9', { mode: 'manual', actor, allowCrossOwner: true, restoreRevokedAssignments: true }],
  ])('does not write mappings after writer wait: %s', async (_label, sql, options) => {
    const before = localState();
    let verifyWait;
    download.pause = async () => { verifyWait = await holdWriterUntilApply(sql); };

    const result = await performSync(7, 1, options);

    await verifyWait();
    expect(localState()).toEqual(before);
    expect(result.status).toBe('error');
    expect(db.prepare('SELECT last_sync FROM sync_configs WHERE id = 1').get().last_sync).toBe(111);
  });

  it.each([undefined, { ...actor, is_admin: false }])('rejects an unverified manual actor (%j)', async manualActor => {
    const before = localState();
    const result = await performSync(7, 1, { mode: 'manual', actor: manualActor, allowCrossOwner: true, restoreRevokedAssignments: true });
    expect(localState()).toEqual(before);
    expect(result.status).toBe('error');
  });

  it('reloads mapping targets after a writer changed their owner', async () => {
    let verifyWait;
    download.pause = async () => {
      verifyWait = await holdWriterUntilApply('UPDATE user_categories SET user_id = 2 WHERE id = 5');
    };
    const result = await performSync(7, 1, { mode: 'scheduled' });
    await verifyWait();
    expect(result.status).toBe('success');
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(1);
    expect(db.prepare('SELECT authorization_revoked FROM user_channels WHERE id = 30').get().authorization_revoked).toBe(1);
  });

  it('preserves existing assignment IDs and customization with an unchanged grant', async () => {
    const result = await performSync(7, 1, { mode: 'scheduled' });
    expect(result.status).toBe('success');
    expect(db.prepare('SELECT id, custom_name, is_hidden, sort_order, authorization_revoked FROM user_channels WHERE id = 30').get())
      .toEqual({ id: 30, custom_name: 'Keep my name', is_hidden: 1, sort_order: 8, authorization_revoked: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM user_channels').get().count).toBe(2);
  });

  it.each([
    ['category changes owner', 'UPDATE user_categories SET user_id = 2 WHERE id = 5'],
    ['mapping retargets after category changes owner', 'UPDATE user_categories SET user_id = 2 WHERE id = 5; UPDATE category_mappings SET user_category_id = 6 WHERE id = 1'],
    ['mapping retargets to a foreign category', 'UPDATE category_mappings SET user_category_id = 7 WHERE id = 1'],
  ])('preserves assignments when a channel moves and %s during writer wait', async (_label, sql) => {
    db.exec("INSERT INTO user_categories (id, user_id, name, type) VALUES (6, 1, 'Owned', 'live'), (7, 2, 'Foreign', 'live')");
    const before = db.prepare('SELECT * FROM user_channels WHERE id = 30').get();
    const catalog = fetchCatalog.getMockImplementation();
    fetchCatalog.mockImplementation(async (...args) => {
      const result = await catalog(...args);
      for (const channel of result.allChannels) channel.category_id = 99;
      return result;
    });
    let verifyWait;
    download.pause = async () => { verifyWait = await holdWriterUntilApply(sql); };

    const result = await performSync(7, 1, { mode: 'scheduled' });

    await verifyWait();
    expect(result.status).toBe('success');
    expect(db.prepare('SELECT * FROM user_channels WHERE id = 30').get()).toEqual(before);
  });
});

describe('provider configuration during a catalog download', () => {
  it.each([
    ['url', 'http://new-panel.example'], ['username', 'new-account'], ['password', 'new-secret'],
    ['user_agent', 'NewAgent/1.0'], ['backup_urls', '["http://backup.example"]'],
  ])('does not publish the old snapshot after changing %s with the same owner', async (column, value) => {
    db.exec('UPDATE providers SET user_id = 1 WHERE id = 7');
    const before = localState();
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    download.pause = () => { started.resolve(); return resume.promise; };
    const run = performSync(7, 1, { mode: 'scheduled' });
    await started.promise;
    // This connection commits while the asynchronous download is paused.
    const { default: Database } = await import('better-sqlite3');
    const editor = new Database(DB_PATH);
    try { editor.prepare(`UPDATE providers SET ${column} = ? WHERE id = 7`).run(column === 'password' ? encrypt(value) : value); }
    finally { editor.close(); resume.resolve(); }

    const result = await run;

    expect(localState()).toEqual(before);
    expect(result.status).toBe('error');
    expect(result.errorMessage).not.toContain(value);
    expect(result.errorMessage).not.toContain('original-secret');
    expect(db.prepare('SELECT last_sync FROM sync_configs WHERE id = 1').get().last_sync).toBe(111);
  });

  it('validates configuration again after waiting for the writer lock', async () => {
    db.exec('UPDATE providers SET user_id = 1 WHERE id = 7');
    const before = localState();
    let verifyWait;
    download.pause = async () => { verifyWait = await holdWriterUntilApply("UPDATE providers SET url = 'http://new-panel.example' WHERE id = 7"); };
    const result = await performSync(7, 1, { mode: 'scheduled' });
    await verifyWait();
    expect(localState()).toEqual(before);
    expect(result.status).toBe('error');
  });

  it('allows expiry bookkeeping without invalidating the catalog', async () => {
    download.pause = async () => { db.exec('UPDATE providers SET expiry_date = 2000000000 WHERE id = 7'); };
    expect((await performSync(7, 1, { mode: 'scheduled' })).status).toBe('success');
  });
});
