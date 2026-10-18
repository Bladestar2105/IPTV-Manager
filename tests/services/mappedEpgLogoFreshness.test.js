import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const { directory } = vi.hoisted(() => ({ directory: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'iptv-mapped-epg-logo-')) }));
vi.mock('../../src/config/constants.js', async original => ({
  ...await original(), DATA_DIR: directory, CACHE_DIR: `${directory}/cache`,
  EPG_CACHE_DIR: `${directory}/cache/epg`, EPG_DB_PATH: `${directory}/epg.db`,
}));
import db, { initDb } from '../../src/database/db.js';
import epgDb, { initEpgDb } from '../../src/database/epgDb.js';
import { getEpgLogo, invalidateEpgLogosCache } from '../../src/services/logoResolver.js';

beforeAll(() => { initDb(true); initEpgDb(); });
beforeEach(() => {
  epgDb.prepare('DELETE FROM epg_channels').run();
  db.prepare('DELETE FROM providers').run();
  db.prepare('DELETE FROM epg_sources').run();
  db.prepare("INSERT INTO providers(id,name,url,username,password) VALUES(1,'Provider','https://provider.test/guide.xml','u','p')").run();
  db.prepare("INSERT INTO epg_sources(id,name,url) VALUES(2,'Custom','https://custom.test/guide.xml')").run();
  invalidateEpgLogosCache();
});
afterAll(() => { db.close(); epgDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });

it('reads current mapped artwork immediately while leaving raw catalog caching unchanged', () => {
  epgDb.prepare("INSERT INTO epg_channels(id,name,logo,source_type,source_id) VALUES('news','News','old.png','custom',2)").run();
  expect(getEpgLogo('news')).toBe('old.png');
  expect(getEpgLogo('news', { absolute: true })).toBe('https://custom.test/old.png');
  epgDb.prepare("UPDATE epg_channels SET logo='new.png' WHERE id='news'").run();
  expect(getEpgLogo('news')).toBe('old.png');
  expect(getEpgLogo('news', { absolute: true })).toBe('https://custom.test/new.png');
  epgDb.prepare("DELETE FROM epg_channels WHERE id='news'").run();
  expect(getEpgLogo('news', { absolute: true })).toBeNull();
});

it.each([['provider', 1, 'providers'], ['custom', 2, 'epg_sources']])('stops using absolute mapped URLs after the %s source disappears', (type, id, table) => {
  epgDb.prepare('INSERT INTO epg_channels(id,name,logo,source_type,source_id) VALUES(?,?,?,?,?)')
    .run('news', 'News', 'https://cdn.test/private.png?password=old', type, id);
  expect(getEpgLogo('news')).toBe('https://cdn.test/private.png?password=old');
  expect(getEpgLogo('news', { absolute: true })).toBe('https://cdn.test/private.png?password=old');
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  expect(getEpgLogo('news', { absolute: true })).toBeNull();
});

it('selects the same last nonempty duplicate row as the raw logo cache', () => {
  const insert = epgDb.prepare('INSERT INTO epg_channels(id,name,logo,source_type,source_id) VALUES(?,?,?,?,?)');
  insert.run('news', 'Provider', 'provider.png', 'provider', 1);
  insert.run('news', 'Custom', 'custom.png', 'custom', 2);
  expect(getEpgLogo('news')).toBe('custom.png');
  expect(getEpgLogo('news', { absolute: true })).toBe('https://custom.test/custom.png');
});
