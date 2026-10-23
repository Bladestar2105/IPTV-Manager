import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import * as migrations from '../src/database/migrations.js';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../src/utils/network.js', async original => ({ ...(await original()), fetchSafe }));
vi.mock('../src/database/db.js', async () => {
  const { default: Db } = await import('better-sqlite3');
  const database = new Db(':memory:');
  database.exec(`CREATE TABLE epg_sources(id INTEGER PRIMARY KEY, last_attempt INTEGER DEFAULT 0, last_update INTEGER DEFAULT 0, is_updating INTEGER DEFAULT 0);
    CREATE TABLE providers(id INTEGER PRIMARY KEY, last_epg_attempt INTEGER DEFAULT 0, last_epg_update INTEGER DEFAULT 0);`);
  return { default: database };
});
vi.mock('../src/services/logoResolver.js', () => ({ invalidateEpgLogosCache: vi.fn() }));

const { default: mainDb } = await import('../src/database/db.js');
const { initEpgDb, default: epgDb } = await import('../src/database/epgDb.js');
const { importEpgFromUrl } = await import('../src/services/epgImportService.js');
initEpgDb();

beforeEach(() => {
  fetchSafe.mockReset();
  mainDb.exec('DELETE FROM epg_sources; DELETE FROM providers; INSERT INTO epg_sources(id) VALUES(1); INSERT INTO providers(id) VALUES(1);');
});
afterAll(() => { mainDb.close(); epgDb.close(); });

it('adds persistent attempt timestamps idempotently without changing successful updates', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE epg_sources(id INTEGER PRIMARY KEY, last_update INTEGER); INSERT INTO epg_sources VALUES(7,123);
      CREATE TABLE providers(id INTEGER PRIMARY KEY, last_epg_update INTEGER); INSERT INTO providers VALUES(8,456);`);
    expect(migrations.migrateEpgDownloadAttempts).toBeTypeOf('function');
    migrations.migrateEpgDownloadAttempts(database);
    database.prepare('UPDATE epg_sources SET last_attempt=789').run();
    migrations.migrateEpgDownloadAttempts(database);
    expect(database.prepare('SELECT * FROM epg_sources').get()).toEqual({ id: 7, last_update: 123, last_attempt: 789 });
    expect(database.prepare('SELECT * FROM providers').get()).toEqual({ id: 8, last_epg_update: 456, last_epg_attempt: 0 });
  } finally { database.close(); }
});

it.each(['custom', 'provider'])('persists the %s attempt before HTTP 403 without claiming success', async type => {
  const table = type === 'custom' ? 'epg_sources' : 'providers';
  const column = type === 'custom' ? 'last_attempt' : 'last_epg_attempt';
  const success = type === 'custom' ? 'last_update' : 'last_epg_update';
  fetchSafe.mockImplementation(async () => {
    expect(mainDb.prepare(`SELECT ${column} AS attempted FROM ${table}`).get().attempted).toBeGreaterThan(0);
    return { ok: false, status: 403, body: Readable.from([]) };
  });
  await expect(importEpgFromUrl('https://epg.example/guide.xml', type, 1)).rejects.toThrow('HTTP 403');
  expect(mainDb.prepare(`SELECT ${column} AS attempted, ${success} AS updated FROM ${table}`).get())
    .toEqual({ attempted: expect.any(Number), updated: 0 });
});

it.each(['custom', 'provider'])('retains the %s download attempt when local import fails', async type => {
  const table = type === 'custom' ? 'epg_sources' : 'providers';
  const column = type === 'custom' ? 'last_attempt' : 'last_epg_attempt';
  fetchSafe.mockResolvedValue({ ok: true, body: new Readable({ read() { this.destroy(new Error('local import failure')); } }) });
  await expect(importEpgFromUrl('https://epg.example/guide.xml', type, 1)).rejects.toThrow('local import failure');
  expect(mainDb.prepare(`SELECT ${column} AS attempted FROM ${table}`).get().attempted).toBeGreaterThan(0);
});
