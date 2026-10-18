import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const { directory } = vi.hoisted(() => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  return { directory: fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-category-grants-')) };
});
vi.mock('../../src/config/constants.js', async original => ({
  ...await original(), DATA_DIR: directory, CACHE_DIR: `${directory}/cache`,
  EPG_CACHE_DIR: `${directory}/cache/epg`, EPG_DB_PATH: `${directory}/epg.db`,
}));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));

import db, { initDb } from '../../src/database/db.js';
import epgDb, { initEpgDb } from '../../src/database/epgDb.js';
import { getCategoryChannels } from '../../src/controllers/channelController.js';
import { resolveClientResource } from '../../src/services/clientResourceService.js';

const req = user => ({ user, protocol: 'https', get: key => key === 'host' ? 'manager.test' : undefined,
  app: { get: () => false }, params: { catId: '1' }, query: {}, headers: {}, ip: '203.0.113.1' });
const resolve = (url, user) => resolveClientResource({ ...req(user), params: { data: new URL(url).pathname.split('/')[4] } });
function category(user) {
  let rows;
  getCategoryChannels(req(user), { json: result => { rows = result; }, status: () => { throw new Error('Unexpected category error'); } });
  return rows[0];
}
beforeAll(() => { initDb(true); initEpgDb(); });
beforeEach(() => {
  db.pragma('foreign_keys = OFF');
  for (const table of ['user_channels', 'user_categories', 'provider_channels', 'providers', 'epg_sources', 'users', 'admin_users']) db.prepare(`DELETE FROM ${table}`).run();
  epgDb.prepare('DELETE FROM epg_channels').run();
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO users(id, username, password, is_active) VALUES(7, 'owner', 'unused', 1), (8, 'other', 'unused', 1)").run();
  db.prepare("INSERT INTO admin_users(id, username, password, is_active) VALUES(9, 'admin', 'unused', 1)").run();
  db.prepare("INSERT INTO providers(id, user_id, name, url, username, password) VALUES(1, 7, 'Original', 'https://provider.example', 'unused', 'unused'), (2, 7, 'Replacement', 'https://replacement.example', 'unused', 'unused')").run();
  db.prepare("INSERT INTO user_categories(id, user_id, name) VALUES(1, 7, 'Channels')").run();
  db.prepare("INSERT INTO provider_channels(id, provider_id, remote_stream_id, name, logo, youtube_trailer) VALUES(1, 1, 100, 'Channel', 'https://provider.example/logo.png', 'https://provider.example/trailer')").run();
  db.prepare('INSERT INTO user_channels(id, user_category_id, provider_channel_id) VALUES(1, 1, 1)').run();
});
afterAll(() => { db.close(); epgDb.close(); fs.rmSync(directory, { recursive: true, force: true }); });

it('revokes old category metadata and artwork when the channel changes provider pool', async () => {
  const user = { id: 7, is_admin: false, provider_access: 0 };
  const row = category(user);
  for (const url of [row.logo, row.youtube_trailer]) expect(await resolve(url, user)).toMatchObject({ providerId: 1, channelId: 1 });
  db.prepare('UPDATE provider_channels SET provider_id = 2 WHERE id = 1').run();
  for (const url of [row.logo, row.youtube_trailer]) expect(await resolve(url, user)).toBeNull();
});
it('revokes provider-management category artwork after provider transfer', async () => {
  const user = { id: 7, is_admin: false, provider_access: 1 };
  const row = category(user);
  expect(await resolve(row.logo, user)).toMatchObject({ providerId: 1, channelId: 1 });
  db.prepare('UPDATE providers SET user_id = 8 WHERE id = 1').run();
  expect(await resolve(row.logo, user)).toBeNull();
});
it('keeps absent category artwork empty instead of issuing an unusable image URL', () => {
  db.prepare("UPDATE provider_channels SET logo = '' WHERE id = 1").run();
  expect(category({ id: 7, is_admin: false }).logo).toBe('');
});
it('keeps explicitly granted cross-owner artwork available with provider management access', async () => {
  db.prepare('UPDATE providers SET user_id = 8 WHERE id = 1').run();
  db.prepare('UPDATE user_channels SET granted_by_admin = 1 WHERE id = 1').run();
  const user = { id: 7, is_admin: false, provider_access: 1 };
  expect(await resolve(category(user).logo, user)).toMatchObject({ providerId: 1, channelId: 1 });
});
it('binds admin category artwork to the existing provider without requiring category ownership', async () => {
  const user = { id: 9, is_admin: true };
  const row = category(user);
  expect(await resolve(row.logo, user)).toMatchObject({ providerId: 1, channelId: null });
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM providers WHERE id = 1').run();
  db.pragma('foreign_keys = ON');
  expect(await resolve(row.logo, user)).toBeNull();
});
it('refreshes mapped EPG artwork and drops an orphaned source on an existing category URL', async () => {
  db.prepare("INSERT INTO epg_sources(id, name, url) VALUES(2, 'Shared EPG', 'https://epg.example/guide.xml')").run();
  db.prepare('UPDATE providers SET use_mapped_epg_icon = 1 WHERE id = 1').run();
  db.prepare("UPDATE provider_channels SET epg_channel_id = 'news' WHERE id = 1").run();
  epgDb.prepare("INSERT INTO epg_channels(id, name, logo, source_type, source_id) VALUES('news', 'News', 'https://epg.example/old.png?password=old', 'custom', 2)").run();
  const user = { id: 7, is_admin: false, provider_access: 0 };
  const url = category(user).logo;
  expect(await resolve(url, user)).toMatchObject({ url: 'https://epg.example/old.png?password=old' });
  epgDb.prepare("UPDATE epg_channels SET logo = 'https://epg.example/current.png' WHERE id = 'news'").run();
  expect(await resolve(url, user)).toMatchObject({ url: 'https://epg.example/current.png' });
  db.prepare('DELETE FROM epg_sources WHERE id = 2').run();
  expect(await resolve(url, user)).toMatchObject({ url: 'https://provider.example/logo.png' });
});
