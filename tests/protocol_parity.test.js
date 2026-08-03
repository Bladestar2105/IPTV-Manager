import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';

const { TEST_DB_DIR } = vi.hoisted(() => {
  const fsModule = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  return { TEST_DB_DIR: fsModule.mkdtempSync(path.join(os.tmpdir(), 'iptv-protocol-parity-')) };
});

vi.mock('../src/config/constants.js', async () => {
  const actual = await vi.importActual('../src/config/constants.js');
  return {
    ...actual,
    DATA_DIR: TEST_DB_DIR,
    CACHE_DIR: `${TEST_DB_DIR}/cache`,
    EPG_CACHE_DIR: `${TEST_DB_DIR}/cache/epg`,
    EPG_DB_PATH: `${TEST_DB_DIR}/epg.db`,
    BCRYPT_ROUNDS: 1,
  };
});

import app from '../src/app.js';
import db, { initDb } from '../src/database/db.js';
import epgDb from '../src/database/epgDb.js';
import { encrypt } from '../src/utils/crypto.js';
import { providerSourceKey } from '../src/utils/helpers.js';
import { tokenCache } from '../src/services/authService.js';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/protocol-parity.json', import.meta.url), 'utf8'),
);
const credentials = { username: 'parity-user', password: 'parity-pass' };
const mac = '02:00:00:00:06:18';

const categoryId = (id) => Number(id);
const typeRows = {
  live: fixture.live,
  movie: fixture.movies,
  series: fixture.series,
};
const numericId = (type, index) => ({ live: [42, 43, 44, 45], movie: [200, 201, 202], series: [300, 301, 302] }[type][index]);

function attr(line, name) {
  return line.match(new RegExp(`${name}="([^"]*)"`))?.[1] || '';
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXTINF:')) continue;
    const line = lines[index];
    const comma = line.indexOf(',');
    entries.push({
      type: line,
      name: comma === -1 ? '' : line.slice(comma + 1),
      tvgId: attr(line, 'tvg-id'),
      groupId: attr(line, 'group-id'),
      url: lines[index + 1] || '',
    });
  }
  return entries;
}

describe('real protocol output parity', () => {
  let userId;
  let providerId;
  let otherProviderId;
  const categoryIds = [10, 11, 12, 20, 21, 30];
  const insertedUserChannelIds = [];

  beforeAll(() => {
    initDb(true);

    userId = Number(db.prepare(`
      INSERT INTO users (username, password, plain_password, is_active)
      VALUES (?, ?, ?, 1)
    `).run(credentials.username, encrypt(credentials.password), encrypt(credentials.password)).lastInsertRowid);
    const otherUserId = Number(db.prepare(`
      INSERT INTO users (username, password, is_active)
      VALUES ('parity-other', ?, 1)
    `).run(encrypt('other-pass')).lastInsertRowid);

    providerId = Number(db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES ('Parity provider', 'https://upstream.fixture.invalid/panel', 'upstream-user', ?, ?)
    `).run(encrypt('upstream-pass'), userId).lastInsertRowid);
    otherProviderId = Number(db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES ('Foreign provider', 'https://foreign.fixture.invalid/panel', 'foreign-user', ?, ?)
    `).run(encrypt('foreign-pass'), otherUserId).lastInsertRowid);

    const categories = new Map(
      [...fixture.live, ...fixture.movies, ...fixture.series]
        .filter(({ authorized }) => authorized)
        .map(({ categoryId: id, categoryTitle, type = id.startsWith('3') ? 'series' : id.startsWith('2') ? 'movie' : 'live' }) => [
          Number(id),
          { name: categoryTitle, type },
        ]),
    );
    const insertCategory = db.prepare(`
      INSERT INTO user_categories (id, user_id, name, type, sort_order, is_adult)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const [id, category] of categories) {
      insertCategory.run(id, userId, category.name, category.type, id, category.name.toLowerCase().includes('adult') ? 1 : 0);
    }

    const insertProviderChannel = db.prepare(`
      INSERT INTO provider_channels
        (provider_id, remote_stream_id, name, original_category_id, stream_type, epg_channel_id, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertUserChannel = db.prepare(`
      INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order, is_hidden, authorization_revoked)
      VALUES (?, ?, ?, ?, ?)
    `);
    const add = (type, row, index, { foreign = false, hidden = false } = {}) => {
      const remoteId = numericId(type, index);
      const category = categoryId(row.categoryId);
      const provider = foreign ? otherProviderId : providerId;
      const providerChannelId = Number(insertProviderChannel.run(
        provider,
        remoteId,
        row.name,
        category,
        type === 'movie' ? 'movie' : type,
        row.epgId || '',
        type === 'movie' || type === 'series' ? 'mp4' : 'ts',
      ).lastInsertRowid);
      const userChannelId = Number(insertUserChannel.run(category, providerChannelId, index, hidden ? 1 : 0, 0).lastInsertRowid);
      insertedUserChannelIds.push(userChannelId);
      return { providerChannelId, userChannelId, remoteId };
    };

    fixture.live.forEach((row, index) => add('live', row, index, { hidden: !row.authorized }));
    fixture.movies.forEach((row, index) => add('movie', row, index, { foreign: !row.authorized }));
    fixture.series.forEach((row, index) => add('series', row, index, { foreign: !row.authorized }));

    db.prepare(`
      INSERT INTO provider_series_episodes
        (source_key, series_remote_id, remote_episode_id, season, episode_num, title, container_extension)
      VALUES (?, 300, 9001, 1, 1, 'Pilot', 'mp4'), (?, 300, 9002, 1, 2, 'Second', 'mp4')
    `).run(providerSourceKey('https://upstream.fixture.invalid/panel'), providerSourceKey('https://upstream.fixture.invalid/panel'));

    db.prepare(`
      INSERT INTO stalker_devices (user_id, mac, model, serial_number, device_uid)
      VALUES (?, ?, 'MAG254', 'parity-serial', 'parity-device')
    `).run(userId, mac);
  });

  afterAll(() => {
    tokenCache.clear();
    if (insertedUserChannelIds.length) {
      db.prepare(`DELETE FROM series_episode_aliases WHERE user_channel_id IN (${insertedUserChannelIds.map(() => '?').join(',')})`).run(...insertedUserChannelIds);
      db.prepare(`DELETE FROM user_channels WHERE id IN (${insertedUserChannelIds.map(() => '?').join(',')})`).run(...insertedUserChannelIds);
    }
    db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ?').run(providerSourceKey('https://upstream.fixture.invalid/panel'));
    db.prepare('DELETE FROM stalker_devices WHERE mac = ?').run(mac);
    db.prepare('DELETE FROM user_categories WHERE id IN (?, ?, ?, ?, ?, ?)').run(...categoryIds);
    db.prepare('DELETE FROM provider_channels WHERE provider_id IN (?, ?)').run(providerId, otherProviderId);
    db.prepare('DELETE FROM providers WHERE id IN (?, ?)').run(providerId, otherProviderId);
    db.prepare('DELETE FROM users WHERE username IN (?, ?)').run(credentials.username, 'parity-other');
    epgDb.close();
    db.close();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  it('keeps authorized catalog identity and filtering aligned across Xtream, Stalker, and M3U', async () => {
    const xtream = async (action, extra = {}) => {
      const response = await request(app).get('/player_api.php').query({ ...credentials, action, ...extra });
      expect(response.status).toBe(200);
      return response.body;
    };

    const xtreamByType = {
      live: await xtream('get_live_streams'),
      movie: await xtream('get_vod_streams'),
      series: await xtream('get_series'),
    };
    const xtreamCategories = {
      live: await xtream('get_live_categories'),
      movie: await xtream('get_vod_categories'),
      series: await xtream('get_series_categories'),
    };
    for (const [type, rows] of Object.entries(typeRows)) {
      const expectedCategories = new Set(rows.filter(({ authorized }) => authorized).map(({ categoryTitle }) => categoryTitle));
      expect(new Set(xtreamCategories[type].map(({ category_name: name }) => name))).toEqual(expectedCategories);
    }

    const handshake = await request(app)
      .get('/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .query({ type: 'stb', action: 'handshake' });
    expect(handshake.status).toBe(200);
    const token = handshake.body.js.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stalker = async (type, action, extra = {}) => {
      const response = await request(app)
        .get('/server/load.php')
        .set('Authorization', `Bearer ${token}`)
        .set('Cookie', `mac=${encodeURIComponent(mac)}`)
        .query({ type, action, ...extra });
      expect(response.status).toBe(200);
      return response.body.js;
    };

    const stalkerByType = {};
    for (const [type, stalkerType] of Object.entries({ live: 'itv', movie: 'vod', series: 'series' })) {
      const categories = await stalker(stalkerType, 'get_categories');
      expect(categories[0]).toEqual(expect.objectContaining({ id: '*', alias: 'all' }));
      expect(new Set(categories.slice(1).map(({ title }) => title))).toEqual(
        new Set(xtreamCategories[type].map(({ category_name: name }) => name)),
      );

      const items = [];
      for (const category of categories.slice(1)) {
        const page = await stalker(stalkerType, 'get_ordered_list', { category: category.id, p: 1 });
        items.push(...page.data);
      }
      stalkerByType[type] = items;
      expect(new Set(items.map(({ id }) => id))).toEqual(new Set(xtreamByType[type].map(({ stream_id, series_id }) => String(stream_id ?? series_id))));
    }

    const playlistResponse = await request(app).get('/get.php').query({ ...credentials, type: 'm3u_plus' });
    expect(playlistResponse.status).toBe(200);
    const playlistText = playlistResponse.text || playlistResponse.body?.toString('utf8') || '';
    const playlist = parseM3U(playlistText);
    expect(playlist).toHaveLength(7);
    expect(playlist.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'Fixture News',
      'Fixture News duplicate',
      'Fixture Adult Live',
      'Fixture Movie',
      'Fixture Adult Movie',
      'Fixture Series S01 E01',
      'Fixture Series S01 E02',
    ]));
    expect(playlist.map(({ groupId }) => groupId)).toEqual(expect.arrayContaining(['10', '11', '12', '20', '21', '30']));
    expect(playlist.filter(({ tvgId }) => tvgId === 'fixture.same')).toHaveLength(2);
    expect(playlist.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      'Fixture Hidden',
      'Fixture Unauthorized Movie',
      'Fixture Unauthorized Series',
      'Fixture Unsynchronized Series',
    ]));
    expect(playlistText).not.toContain('upstream-pass');
    expect(playlistText).not.toContain('foreign-pass');
  });
});
