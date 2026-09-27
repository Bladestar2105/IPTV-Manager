import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProviderLockTable } from '../src/database/providerLockSchema.js';

let currentDb, firstDb, secondDb, directory;
const { importer } = vi.hoisted(() => ({importer: vi.fn()}));
vi.mock('../src/database/db.js', () => ({get default() {return currentDb;}, openLatencyDbConnection: () => currentDb}));
vi.mock('../src/database/epgDb.js', () => ({default: {}}));
vi.mock('../src/config/constants.js', () => ({EPG_DB_PATH: ':memory:'}));
vi.mock('../src/services/logoResolver.js', () => ({invalidateEpgLogosCache: vi.fn()}));
vi.mock('../src/services/epgImportService.js', () => ({importEpgFromUrl: importer}));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'iptv-epg-lock-'));
  firstDb = new Database(join(directory,'db.sqlite'));
  firstDb.pragma('journal_mode=WAL');
  firstDb.exec(`CREATE TABLE epg_sources(id INTEGER, url TEXT);
    INSERT INTO epg_sources VALUES(1,'https://source.example/epg.xml');
    CREATE TABLE providers(id INTEGER, epg_enabled INTEGER, epg_url TEXT, last_epg_update INTEGER);
    INSERT INTO providers VALUES(1,1,'https://provider.example/epg.xml',0);`);
  migrateProviderLockTable(firstDb);
  secondDb = new Database(join(directory,'db.sqlite'));
  importer.mockReset();
});
afterEach(() => {firstDb.close();secondDb.close();rmSync(directory,{recursive:true,force:true});});

it.each(['updateEpgSource','updateProviderEpg'])('%s serializes queued and scheduled imports across connections', async method => {
  currentDb = firstDb;
  vi.resetModules();
  const first = await import('../src/services/epgService.js');
  let release;
  importer.mockImplementationOnce(() => new Promise(resolve => {release=resolve;}));
  const running = first[method](1,true);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  currentDb = secondDb;
  vi.resetModules();
  const other = await import('../src/services/epgService.js');
  try {
    await expect(other[method](1,true)).rejects.toMatchObject({code:'EPG_UPDATE_LOCKED'});
    expect(importer).toHaveBeenCalledTimes(1);
  } finally {release();await running;}
  await other[method](1,true);
  expect(importer).toHaveBeenCalledTimes(2);
  expect(secondDb.prepare('SELECT COUNT(*) n FROM provider_locks').get().n).toBe(0);
});
