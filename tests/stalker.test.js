import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import db, { initDb } from '../src/database/db.js';
import epgDb, { initEpgDb } from '../src/database/epgDb.js';
import { generateToken, getXtreamUser, tokenCache } from '../src/services/authService.js';
import { migrateStalkerTables } from '../src/database/migrations.js';
import { decrypt } from '../src/utils/crypto.js';
import { providerSourceKey } from '../src/utils/helpers.js';
import { formatStalkerDateTime, STALKER_TIMEZONE } from '../src/utils/stalker.js';

describe('Stalker/MAG portal flow', () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const mac = '02:00:00:00:06:09';
  const upstreamUrl = `http://provider-${stamp}.invalid`;
  const authorizedChannelIds = [];
  const adultChannelIds = [];
  const hiddenChannelIds = [];
  const revokedChannelIds = [];
  const unauthorizedChannelIds = [];
  const epgIds = [];
  let adminId;
  let adminToken;
  let userId;
  let otherUserId;
  let providerId;
  let otherProviderId;
  let categoryId;
  let secondCategoryId;
  let adultCategoryId;
  let movieCategoryId;
  let adultMovieCategoryId;
  let seriesCategoryId;
  let radioCategoryId;
  let movieChannelId;
  let adultMovieChannelId;
  let seriesChannelId;
  let radioChannelId;
  let archivedProgramStart;
  let archivedProgramStop;
  let epgSourceId;

  const streamUser = (token, ip = '127.0.0.1') => getXtreamUser({
    params: {},
    query: { token },
    headers: {},
    ip
  });

  async function registerDevice(body = {}) {
    const response = await request(app)
      .post(`/api/users/${userId}/stalker-devices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mac, ...body });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function handshake() {
    const response = await request(app)
      .get('/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .query({ type: 'stb', action: 'handshake' });
    expect(response.body.js.token).toMatch(/^[0-9a-f]{64}$/);
    return response.body.js.token;
  }

  beforeAll(() => {
    initDb(true);
    initEpgDb();
    migrateStalkerTables(db);
    migrateStalkerTables(db);

    adminId = Number(db.prepare(`
      INSERT INTO admin_users (username, password, is_active)
      VALUES (?, 'unused', 1)
    `).run(`stalker_admin_${stamp}`).lastInsertRowid);
    adminToken = generateToken({
      id: adminId,
      username: `stalker_admin_${stamp}`,
      is_active: 1,
      is_admin: true,
      token_version: 0
    });

    userId = Number(db.prepare(`
      INSERT INTO users (username, password, is_active)
      VALUES (?, 'unused', 1)
    `).run(`stalker_user_${stamp}`).lastInsertRowid);
    otherUserId = Number(db.prepare(`
      INSERT INTO users (username, password, is_active)
      VALUES (?, 'unused', 1)
    `).run(`stalker_other_${stamp}`).lastInsertRowid);
    providerId = Number(db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES (?, ?, 'upstream', 'unused', ?)
    `).run(`Stalker ${stamp}`, upstreamUrl, userId).lastInsertRowid);
    otherProviderId = Number(db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES (?, 'http://other.invalid', 'upstream', 'unused', ?)
    `).run(`Stalker other ${stamp}`, otherUserId).lastInsertRowid);
    categoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order)
      VALUES (?, 'Live A', 'live', 0)
    `).run(userId).lastInsertRowid);
    secondCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order)
      VALUES (?, 'Live B', 'live', 1)
    `).run(userId).lastInsertRowid);
    adultCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order, is_adult)
      VALUES (?, 'Adult', 'live', 2, 1)
    `).run(userId).lastInsertRowid);
    movieCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order)
      VALUES (?, 'Movies', 'movie', 3)
    `).run(userId).lastInsertRowid);
    adultMovieCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order, is_adult)
      VALUES (?, 'Adult Movies', 'movie', 4, 1)
    `).run(userId).lastInsertRowid);
    seriesCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order)
      VALUES (?, 'Series', 'series', 5)
    `).run(userId).lastInsertRowid);
    radioCategoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type, sort_order)
      VALUES (?, 'Radio', 'radio', 6)
    `).run(userId).lastInsertRowid);
    epgSourceId = 9_000_000 + userId;

    const insertProviderChannel = db.prepare(`
      INSERT INTO provider_channels (
        provider_id, remote_stream_id, name, stream_type, original_sort_order, epg_channel_id
      ) VALUES (?, ?, ?, 'live', ?, ?)
    `);
    const insertUserChannel = db.prepare(`
      INSERT INTO user_channels (
        user_category_id, provider_channel_id, sort_order, is_hidden
      ) VALUES (?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (let index = 0; index < 253; index += 1) {
        const providerChannelId = Number(insertProviderChannel.run(
          providerId,
          index + 1,
          `Channel ${String(index + 1).padStart(3, '0')}`,
          index,
          index < 2 ? `${stamp}_epg_${index + 1}` : ''
        ).lastInsertRowid);
        if (index < 2) epgIds.push(`${stamp}_epg_${index + 1}`);
        authorizedChannelIds.push(Number(insertUserChannel.run(
          index < 150 ? categoryId : secondCategoryId,
          providerChannelId,
          index,
          0
        ).lastInsertRowid));
      }

      for (let index = 0; index < 3; index += 1) {
        const hiddenProviderChannelId = Number(insertProviderChannel.run(
          providerId,
          10_000 + index,
          `Hidden ${index}`,
          10_000 + index,
          ''
        ).lastInsertRowid);
        hiddenChannelIds.push(Number(insertUserChannel.run(
          categoryId,
          hiddenProviderChannelId,
          10_000 + index,
          1
        ).lastInsertRowid));

        const unauthorizedProviderChannelId = Number(insertProviderChannel.run(
          otherProviderId,
          20_000 + index,
          `Unauthorized ${index}`,
          20_000 + index,
          ''
        ).lastInsertRowid);
        unauthorizedChannelIds.push(Number(insertUserChannel.run(
          categoryId,
          unauthorizedProviderChannelId,
          20_000 + index,
          0
        ).lastInsertRowid));
      }

      const revokedProviderChannelId = Number(insertProviderChannel.run(
        providerId,
        30_000,
        'Revoked',
        30_000,
        `${stamp}_revoked`
      ).lastInsertRowid);
      revokedChannelIds.push(Number(db.prepare(`
        INSERT INTO user_channels (
          user_category_id, provider_channel_id, sort_order, is_hidden, authorization_revoked
        ) VALUES (?, ?, ?, 0, 1)
      `).run(categoryId, revokedProviderChannelId, 30_000).lastInsertRowid));

      for (let index = 0; index < 3; index += 1) {
        const adultProviderChannelId = Number(insertProviderChannel.run(
          providerId,
          40_000 + index,
          `Adult ${index + 1}`,
          40_000 + index,
          ''
        ).lastInsertRowid);
        adultChannelIds.push(Number(insertUserChannel.run(
          adultCategoryId,
          adultProviderChannelId,
          index,
          0
        ).lastInsertRowid));
      }
    })();

    db.prepare(`
      UPDATE provider_channels
      SET tv_archive = 1, tv_archive_duration = 7
      WHERE provider_id = ? AND remote_stream_id = 1
    `).run(providerId);

    const insertContent = db.prepare(`
      INSERT INTO provider_channels (
        provider_id, remote_stream_id, name, stream_type, original_sort_order,
        mime_type, logo, plot, "cast", director, genre, releaseDate, rating
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      const movieProviderChannelId = Number(insertContent.run(
        providerId, 50_001, 'Fixture Movie', 'movie', 0, 'mkv',
        '/movie.jpg', 'Movie plot', 'Actor One', 'Director One', 'Drama', '2026-01-02', '8.1'
      ).lastInsertRowid);
      movieChannelId = Number(insertUserChannel.run(
        movieCategoryId, movieProviderChannelId, 0, 0
      ).lastInsertRowid);

      const adultMovieProviderChannelId = Number(insertContent.run(
        providerId, 50_002, 'Fixture Adult Movie', 'movie', 1, 'mp4',
        '/adult-movie.jpg', '', '', '', '', '', ''
      ).lastInsertRowid);
      adultMovieChannelId = Number(insertUserChannel.run(
        adultMovieCategoryId, adultMovieProviderChannelId, 0, 0
      ).lastInsertRowid);

      const seriesProviderChannelId = Number(insertContent.run(
        providerId, 60_001, 'Fixture Series', 'series', 0, 'mp4',
        '/series.jpg', 'Series plot', 'Actor Two', 'Director Two', 'Mystery', '2025-03-04', '7.9'
      ).lastInsertRowid);
      seriesChannelId = Number(insertUserChannel.run(
        seriesCategoryId, seriesProviderChannelId, 0, 0
      ).lastInsertRowid);

      const radioProviderChannelId = Number(insertContent.run(
        providerId, 70_001, 'Fixture Radio', 'live', 0, 'ts',
        '/radio.jpg', '', '', '', '', '', ''
      ).lastInsertRowid);
      radioChannelId = Number(insertUserChannel.run(
        radioCategoryId, radioProviderChannelId, 0, 0
      ).lastInsertRowid);
    })();

    const seriesSourceKey = providerSourceKey(upstreamUrl);
    db.prepare(`
      INSERT INTO provider_series_episodes (
        source_key, series_remote_id, remote_episode_id, season, episode_num,
        title, container_extension, logo, added
      ) VALUES
        (?, 60001, 61001, 1, 1, 'Pilot', 'mkv', '/episode-1.jpg', ''),
        (?, 60001, 61002, 1, 2, 'Second', 'mp4', '/episode-2.jpg', ''),
        (?, 60001, 62001, 2, 1, 'Return', 'mp4', '/episode-3.jpg', '')
    `).run(seriesSourceKey, seriesSourceKey, seriesSourceKey);

    const now = Math.floor(Date.now() / 1000);
    archivedProgramStart = now - 7200;
    archivedProgramStop = now - 3600;
    const insertEpgChannel = epgDb.prepare(`
      INSERT INTO epg_channels (id, name, source_type, source_id, updated_at)
      VALUES (?, ?, 'custom', ?, ?)
    `);
    const insertProgram = epgDb.prepare(`
      INSERT INTO epg_programs (
        channel_id, source_type, source_id, start, stop, title, desc, lang
      ) VALUES (?, 'custom', ?, ?, ?, ?, ?, 'en')
    `);
    epgDb.transaction(() => {
      epgIds.forEach((epgId, index) => {
        insertEpgChannel.run(epgId, `EPG ${index + 1}`, epgSourceId, now);
      });
      insertProgram.run(
        epgIds[0],
        epgSourceId,
        archivedProgramStart,
        archivedProgramStop,
        'Archived Show',
        'Archived description'
      );
      insertProgram.run(epgIds[0], epgSourceId, now - 60, now + 1800, 'Current Show', 'Current description');
      insertProgram.run(epgIds[0], epgSourceId, now + 1800, now + 3600, 'Next Show', 'Next description');
      insertProgram.run(epgIds[0], epgSourceId, now + 167 * 3600, now + 167 * 3600 + 1800, 'Within Clamp', '');
      insertProgram.run(epgIds[0], epgSourceId, now + 169 * 3600, now + 169 * 3600 + 1800, 'Beyond Clamp', '');
      insertProgram.run(epgIds[1], epgSourceId, now - 30, now + 1200, 'Second Channel', 'Second description');
    })();
  });

  beforeEach(() => {
    tokenCache.clear();
    db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET is_active = 1, expiry_date = NULL, allowed_countries = NULL WHERE id = ?').run(userId);
  });

  afterAll(() => {
    tokenCache.clear();
    if (epgSourceId) {
      epgDb.prepare(`DELETE FROM epg_programs WHERE source_type = 'custom' AND source_id = ?`).run(epgSourceId);
      epgDb.prepare(`DELETE FROM epg_channels WHERE source_type = 'custom' AND source_id = ?`).run(epgSourceId);
    }
    if (userId) {
      db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM series_episode_aliases WHERE user_channel_id = ?').run(seriesChannelId);
      db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ?')
        .run(providerSourceKey(upstreamUrl));
      db.prepare('DELETE FROM user_channels WHERE user_category_id IN (?, ?, ?, ?, ?, ?, ?)')
        .run(
          categoryId,
          secondCategoryId,
          adultCategoryId,
          movieCategoryId,
          adultMovieCategoryId,
          seriesCategoryId,
          radioCategoryId
        );
      db.prepare('DELETE FROM user_categories WHERE id IN (?, ?, ?, ?, ?, ?, ?)')
        .run(
          categoryId,
          secondCategoryId,
          adultCategoryId,
          movieCategoryId,
          adultMovieCategoryId,
          seriesCategoryId,
          radioCategoryId
        );
      db.prepare('DELETE FROM provider_channels WHERE provider_id IN (?, ?)').run(providerId, otherProviderId);
      db.prepare('DELETE FROM providers WHERE id IN (?, ?)').run(providerId, otherProviderId);
      db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(userId, otherUserId);
    }
    if (adminId) db.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId);
  });

  it('supports Stalker request variants and complete channel listing', async () => {
    await registerDevice();
    const token = await handshake();

    const bearerProfile = await request(app)
      .get('/portal.php')
      .set('Authorization', `Bearer ${token}`)
      .query({ type: 'stb', action: 'get_profile' });
    expect(bearerProfile.body.js.name).toBe(`stalker_user_${stamp}`);

    const tokenProfile = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', token });
    expect(tokenProfile.body.js.name).toBe(`stalker_user_${stamp}`);

    const accessTokenProfile = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', access_token: token });
    expect(accessTokenProfile.body.js.name).toBe(`stalker_user_${stamp}`);

    const formHandshake = await request(app)
      .post('/stalker_portal/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .type('form')
      .send({ type: 'stb', action: 'handshake' });
    expect(formHandshake.body.js.token).toMatch(/^[0-9a-f]{64}$/);
    const activeToken = formHandshake.body.js.token;

    const formProfile = await request(app)
      .post('/server/load.php')
      .type('form')
      .send({ type: 'stb', action: 'get_profile', access_token: activeToken });
    expect(formProfile.body.js.name).toBe(`stalker_user_${stamp}`);
    expect(formProfile.headers['cache-control']).toBe('no-store');

    const auth = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'do_auth', token: activeToken });
    expect(auth.body).toEqual({ js: true });

    const modules = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_modules', token: activeToken });
    expect(modules.body.js.all_modules)
      .toEqual(['tv', 'vclub', 'series', 'radio', 'tv_archive']);

    const localization = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_localization', token: activeToken });
    expect(localization.body).toEqual({ js: {} });

    const mainInfo = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_main_info', token: activeToken });
    expect(mainInfo.body.js).toHaveProperty('end_date');

    const serverTime = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_time', token: activeToken });
    expect(serverTime.body.js.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formProfile.body.js.timezone).toBe(STALKER_TIMEZONE);

    const genres = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${activeToken}`)
      .query({ type: 'itv', action: 'get_genres' });
    expect(genres.body.js.map(genre => genre.title)).toEqual(['All', 'Live A', 'Live B', 'Adult']);
    expect(genres.body.js.find(genre => genre.id === String(adultCategoryId)).censored).toBe(1);

    const forbiddenIds = new Set([
      ...hiddenChannelIds,
      ...revokedChannelIds,
      ...unauthorizedChannelIds,
      ...adultChannelIds
    ].map(String));
    const firstPageIds = authorizedChannelIds.slice(0, 100).map(String);
    for (const page of [undefined, 0, 1]) {
      const query = { type: 'itv', action: 'get_ordered_list', token: activeToken };
      if (page !== undefined) query.p = page;
      const response = await request(app).get('/server/load.php').query(query);
      expect(response.body.js).toMatchObject({
        total_items: '253',
        max_page_items: 100,
        cur_page: 1
      });
      expect(response.body.js.data.map(channel => channel.id)).toEqual(firstPageIds);
    }

    const listedIds = new Set();
    const expectedPageSizes = [100, 100, 53];
    for (let page = 1; page <= expectedPageSizes.length; page += 1) {
      const response = await request(app)
        .get('/server/load.php')
        .set('Authorization', `Bearer ${activeToken}`)
        .query({ type: 'itv', action: 'get_ordered_list', p: page });
      expect(response.body.js).toMatchObject({
        total_items: '253',
        max_page_items: 100,
        cur_page: page
      });
      expect(response.body.js.data).toHaveLength(expectedPageSizes[page - 1]);
      response.body.js.data.forEach(channel => {
        expect(forbiddenIds.has(channel.id)).toBe(false);
        expect(listedIds.has(channel.id)).toBe(false);
        listedIds.add(channel.id);
      });
    }
    expect(listedIds).toEqual(new Set(authorizedChannelIds.map(String)));

    const categoryPage1 = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: categoryId,
        p: 1
      });
    const categoryPage2 = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: categoryId,
        p: 2
      });
    expect(categoryPage1.body.js.total_items).toBe('150');
    expect(categoryPage1.body.js.data).toHaveLength(100);
    expect(categoryPage2.body.js.data).toHaveLength(50);
    expect([...categoryPage1.body.js.data, ...categoryPage2.body.js.data]
      .every(channel => channel.tv_genre_id === String(categoryId))).toBe(true);

    const categoryAlias = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: '*',
        category: secondCategoryId,
        p: 1
      });
    expect(categoryAlias.body.js.total_items).toBe('103');
    expect(categoryAlias.body.js.data.every(channel => channel.tv_genre_id === String(secondCategoryId))).toBe(true);

    const malformedCategory = await request(app)
      .get('/server/load.php')
      .query({ type: 'itv', action: 'get_ordered_list', token: activeToken, category: '12x' });
    expect(malformedCategory.body.js).toMatchObject({ total_items: '0', cur_page: 1, data: [] });

    const adultCategory = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: adultCategoryId,
        category: '*'
      });
    expect(adultCategory.body.js.data.map(channel => channel.id)).toEqual(adultChannelIds.map(String));

    const allChannels = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_all_channels',
        access_token: activeToken,
        p: 2
      });
    expect(allChannels.body.js).toMatchObject({
      total_items: '253',
      max_page_items: 253,
      cur_page: 1
    });
    expect(allChannels.body.js.data).toHaveLength(253);
    expect(allChannels.body.js.data[0].number).toBe('1');
    expect(allChannels.body.js.data.at(-1).number).toBe('253');
    expect(allChannels.body.js.data.some(channel => forbiddenIds.has(channel.id))).toBe(false);

    const link = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${activeToken}`)
      .query({
        type: 'itv',
        action: 'create_link',
        cmd: `ffmpeg http://localhost/ch/${authorizedChannelIds[0]}_`
    });
    expect(link.body.js.cmd).toContain(`/live/token/auth/${authorizedChannelIds[0]}.ts?token=`);

    for (const channelId of [hiddenChannelIds[0], revokedChannelIds[0], unauthorizedChannelIds[0]]) {
      const deniedLink = await request(app)
        .get('/server/load.php')
        .query({
          type: 'itv',
          action: 'create_link',
          token: activeToken,
          cmd: `ffmpeg http://localhost/ch/${channelId}_`
        });
      expect(deniedLink.body.js).toMatchObject({ cmd: '', error: 'nothing_to_play' });
    }

    expect((await streamUser(activeToken)).id).toBe(userId);
    expect(tokenCache.has(activeToken)).toBe(false);

    const portal = await request(app).get('/c/');
    expect(portal.status).toBe(200);
    expect(portal.text).toContain('data-i18n="stalkerPortalPageTitle"');
  });

  it('returns protocol-compatible short and batched EPG data', async () => {
    await registerDevice();
    const token = await handshake();

    const shortEpg = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_short_epg',
        token,
        ch_id: authorizedChannelIds[0],
        size: 2
      });
    expect(shortEpg.body.js.data).toHaveLength(2);
    expect(shortEpg.body.js.data[0]).toEqual({
      id: expect.any(String),
      ch_id: String(authorizedChannelIds[0]),
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      time_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      name: 'Current Show',
      descr: 'Current description',
      start_timestamp: expect.any(Number),
      stop_timestamp: expect.any(Number),
      duration: 1860,
      mark_archive: 0
    });

    for (const channelId of [
      0,
      99_999_999,
      hiddenChannelIds[0],
      revokedChannelIds[0],
      unauthorizedChannelIds[0]
    ]) {
      const response = await request(app)
        .get('/server/load.php')
        .query({ type: 'itv', action: 'get_short_epg', token, ch_id: channelId });
      expect(response.body).toEqual({ js: { data: [] } });
    }

    const bulk = await request(app)
      .get('/server/load.php')
      .query({ type: 'itv', action: 'get_epg_info', token, period: 999 });
    expect(Object.keys(bulk.body.js.data)).toHaveLength(253);
    expect(bulk.body.js.data[String(authorizedChannelIds[0])].map(program => program.name))
      .toEqual(['Archived Show', 'Current Show', 'Next Show', 'Within Clamp']);
    expect(bulk.body.js.data[String(authorizedChannelIds[1])][0]).toMatchObject({
      ch_id: String(authorizedChannelIds[1]),
      name: 'Second Channel',
      descr: 'Second description',
      duration: 1230
    });
    expect(bulk.body.js.data).not.toHaveProperty(String(hiddenChannelIds[0]));
    expect(bulk.body.js.data).not.toHaveProperty(String(revokedChannelIds[0]));
    expect(bulk.body.js.data).not.toHaveProperty(String(unauthorizedChannelIds[0]));
    expect(bulk.body.js.data).not.toHaveProperty(String(adultChannelIds[0]));
    expect(JSON.stringify(bulk.body)).not.toContain('upstream');
    expect(JSON.stringify(bulk.body)).not.toContain('unused');

    const malformedPeriod = await request(app)
      .get('/server/load.php')
      .query({ type: 'itv', action: 'get_epg_info', token, period: 'invalid' });
    expect(malformedPeriod.body.js.data[String(authorizedChannelIds[0])]
      .some(program => program.name === 'Beyond Clamp')).toBe(false);
  });

  it('serves authorized VOD, series, radio, and catch-up contracts', async () => {
    await registerDevice();
    const token = await handshake();

    const accountInfo = await request(app)
      .get('/server/load.php')
      .query({ type: 'account_info', action: 'get_main_info', token });
    expect(accountInfo.body.js.account_info).toHaveProperty('expire_date');

    const vodCategories = await request(app)
      .get('/server/load.php')
      .query({ type: 'vod', action: 'get_categories', token });
    expect(vodCategories.body.js.map(category => category.title))
      .toEqual(['All', 'Movies', 'Adult Movies']);
    expect(vodCategories.body.js.find(category => category.id === String(adultMovieCategoryId)))
      .toMatchObject({ censored: 1 });

    const vod = await request(app)
      .get('/server/load.php')
      .query({
        type: 'vod',
        action: 'get_ordered_list',
        token,
        category: '*',
        genre: 0,
        search: 'fixture movie',
        p: 1
      });
    expect(vod.body.js).toMatchObject({ total_items: '1', cur_page: 1 });
    expect(vod.body.js.data[0]).toMatchObject({
      id: String(movieChannelId),
      name: 'Fixture Movie',
      category_id: String(movieCategoryId),
      has_files: 1,
      is_series: 0
    });
    expect(vod.body.js.data[0].cmd).toContain(`/stalker/vod/${movieChannelId}`);

    const adultVod = await request(app)
      .get('/server/load.php')
      .query({
        type: 'vod',
        action: 'get_ordered_list',
        token,
        category: adultMovieCategoryId
      });
    expect(adultVod.body.js.data.map(item => item.id)).toEqual([String(adultMovieChannelId)]);

    const movieLink = await request(app)
      .get('/server/load.php')
      .query({
        type: 'vod',
        action: 'create_link',
        token,
        cmd: vod.body.js.data[0].cmd
      });
    expect(movieLink.body.js.cmd)
      .toContain(`/movie/token/auth/${movieChannelId}.mkv?token=`);
    expect(movieLink.body.js.cmd).not.toContain('upstream');
    expect(movieLink.body.js.cmd).not.toContain('unused');

    const seriesCategories = await request(app)
      .get('/server/load.php')
      .query({ type: 'series', action: 'get_categories', token });
    expect(seriesCategories.body.js.map(category => category.title)).toEqual(['All', 'Series']);

    const series = await request(app)
      .get('/server/load.php')
      .query({ type: 'series', action: 'get_ordered_list', token, category: '*' });
    expect(series.body.js.data[0]).toMatchObject({
      id: String(seriesChannelId),
      name: 'Fixture Series',
      has_files: 0,
      is_series: 0
    });

    const seasons = await request(app)
      .get('/server/load.php')
      .query({
        type: 'series',
        action: 'get_ordered_list',
        token,
        movie_id: seriesChannelId
      });
    expect(seasons.body.js).toHaveLength(2);
    expect(seasons.body.js[0]).toMatchObject({
      name: 'Season 1',
      series: ['1', '2']
    });

    const episodeLink = await request(app)
      .get('/server/load.php')
      .query({
        type: 'vod',
        action: 'create_link',
        token,
        cmd: seasons.body.js[0].cmd,
        series: 1
      });
    expect(episodeLink.body.js.cmd)
      .toMatch(/\/series\/token\/auth\/9\d{8}\.mkv\?token=/);
    const episodeAlias = Number(episodeLink.body.js.id);
    expect(db.prepare(`
      SELECT user_channel_id, remote_episode_id
      FROM series_episode_aliases
      WHERE id = ?
    `).get(episodeAlias)).toEqual({
      user_channel_id: seriesChannelId,
      remote_episode_id: 61_001
    });

    const missingEpisode = await request(app)
      .get('/server/load.php')
      .query({
        type: 'vod',
        action: 'create_link',
        token,
        cmd: seasons.body.js[0].cmd,
        series: 999
      });
    expect(missingEpisode.body.js).toMatchObject({ cmd: '', error: 'nothing_to_play' });

    const radioCategories = await request(app)
      .get('/server/load.php')
      .query({ type: 'radio', action: 'get_categories', token });
    expect(radioCategories.body.js.map(category => category.title)).toEqual(['All', 'Radio']);

    const radio = await request(app)
      .get('/server/load.php')
      .query({ type: 'radio', action: 'get_ordered_list', token, category: '*' });
    expect(radio.body.js.data[0]).toMatchObject({
      id: String(radioChannelId),
      name: 'Fixture Radio',
      cmd: `ffrt4://radio/${radioChannelId}`,
      radio: true
    });

    const radioLink = await request(app)
      .get('/server/load.php')
      .query({
        type: 'radio',
        action: 'create_link',
        token,
        cmd: radio.body.js.data[0].cmd
      });
    expect(radioLink.body.js.cmd)
      .toContain(`/live/token/auth/${radioChannelId}.mp3?token=`);
    expect(radioLink.body.js.cmd).toContain('&transcode=true');

    const epg = await request(app)
      .get('/server/load.php')
      .query({ type: 'itv', action: 'get_epg_info', token, period: 1 });
    const archived = epg.body.js.data[String(authorizedChannelIds[0])]
      .find(program => program.name === 'Archived Show');
    expect(archived).toMatchObject({
      ch_id: String(authorizedChannelIds[0]),
      start_timestamp: archivedProgramStart,
      stop_timestamp: archivedProgramStop,
      mark_archive: 1
    });

    const archiveLink = await request(app)
      .get('/server/load.php')
      .query({
        type: 'tv_archive',
        action: 'create_link',
        token,
        cmd: `auto /media/${archived.id}.mpg`
      });
    expect(archiveLink.body.js.cmd)
      .toContain(`/timeshift/token/auth/60/`);
    expect(archiveLink.body.js.cmd)
      .toContain(`/${authorizedChannelIds[0]}.ts?token=`);

    const tamperedArchive = await request(app)
      .get('/server/load.php')
      .query({
        type: 'tv_archive',
        action: 'create_link',
        token,
        cmd: `auto /media/stalker_archive_${hiddenChannelIds[0]}_${archivedProgramStart}_${archivedProgramStop}.mpg`
      });
    expect(tamperedArchive.body.js).toMatchObject({ cmd: '', error: 'nothing_to_play' });

    const unknown = await request(app)
      .get('/server/load.php')
      .query({ type: 'vod', action: 'unsupported_action', token });
    expect(unknown.body).toEqual({ js: {} });
  });

  it('encrypts optional parental PINs and exposes them only to the device profile', async () => {
    const spies = ['log', 'warn', 'error', 'debug']
      .map(method => vi.spyOn(console, method).mockImplementation(() => {}));

    try {
      const device = await registerDevice({ parental_pin: '1234' });
      expect(device).toMatchObject({ parental_pin_configured: true });
      expect(device).not.toHaveProperty('parental_pin');
      expect(device).not.toHaveProperty('parental_pin_encrypted');

      const stored = db.prepare(`
        SELECT parental_pin_encrypted
        FROM stalker_devices
        WHERE id = ?
      `).get(device.id);
      expect(stored.parental_pin_encrypted).not.toBe('1234');
      expect(decrypt(stored.parental_pin_encrypted)).toBe('1234');

      const devices = await request(app)
        .get(`/api/users/${userId}/stalker-devices`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(devices.body[0]).toMatchObject({ parental_pin_configured: true });
      expect(devices.body[0]).not.toHaveProperty('parental_pin');
      expect(devices.body[0]).not.toHaveProperty('parental_pin_encrypted');

      let token = await handshake();
      let profileResponse = await request(app)
        .get('/server/load.php')
        .query({ type: 'stb', action: 'get_profile', token });
      expect(profileResponse.body.js.parent_password).toBe('1234');
      expect(profileResponse.body.js.settings_password).toBe('');

      await request(app)
        .put(`/api/users/${userId}/stalker-devices/${device.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ parental_pin: '12x4' })
        .expect(400, { error: 'invalid_parental_pin' });

      const updated = await request(app)
        .put(`/api/users/${userId}/stalker-devices/${device.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ parental_pin: '567890' });
      expect(updated.body.parental_pin_configured).toBe(true);
      expect(updated.body).not.toHaveProperty('parental_pin_encrypted');
      expect(await streamUser(token)).toBeNull();

      token = await handshake();
      profileResponse = await request(app)
        .get('/server/load.php')
        .query({ type: 'stb', action: 'get_profile', token });
      expect(profileResponse.body.js.parent_password).toBe('567890');

      const cleared = await request(app)
        .put(`/api/users/${userId}/stalker-devices/${device.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ parental_pin: null });
      expect(cleared.body.parental_pin_configured).toBe(false);
      expect(db.prepare('SELECT parental_pin_encrypted FROM stalker_devices WHERE id = ?').get(device.id)
        .parental_pin_encrypted).toBeNull();

      token = await handshake();
      profileResponse = await request(app)
        .get('/server/load.php')
        .query({ type: 'stb', action: 'get_profile', token });
      expect(profileResponse.body.js.parent_password).toBe('');

      const logs = spies.flatMap(spy => spy.mock.calls).flat().join(' ');
      expect(logs).not.toContain('1234');
      expect(logs).not.toContain('567890');
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }
  });

  it('keeps timezone formatting DST-aware and leaves authorization-view ownership upstream', () => {
    expect(formatStalkerDateTime(new Date('2026-01-15T12:00:00Z'), 'UTC'))
      .toBe('2026-01-15 12:00:00');
    expect(formatStalkerDateTime(new Date('2026-07-31T12:00:00Z'), 'UTC'))
      .toBe('2026-07-31 12:00:00');
    expect(formatStalkerDateTime(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin'))
      .toBe('2026-01-15 13:00:00');
    expect(formatStalkerDateTime(new Date('2026-07-31T12:00:00Z'), 'Europe/Berlin'))
      .toBe('2026-07-31 14:00:00');

    const viewBefore = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'view' AND name = 'authorized_user_channels'
    `).get().sql;
    migrateStalkerTables(db);
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'view' AND name = 'authorized_user_channels'
    `).get().sql).toBe(viewBefore);
    expect(db.prepare('PRAGMA table_info(stalker_devices)').all()
      .some(column => column.name === 'parental_pin_encrypted')).toBe(true);

    const isolated = new Database(':memory:');
    try {
      expect(() => migrateStalkerTables(isolated))
        .toThrow('Stalker/MAG requires the authorized_user_channels authorization view');
    } finally {
      isolated.close();
    }
  });

  it('revokes replaced, disabled, deleted, missing, and expired sessions immediately', async () => {
    let deviceId = (await registerDevice()).id;
    const replacedToken = await handshake();
    expect((await streamUser(replacedToken)).id).toBe(userId);
    expect(tokenCache.has(replacedToken)).toBe(false);

    tokenCache.set(replacedToken, {
      user: { id: userId },
      expiry: Date.now() + 60_000
    });
    const activeToken = await handshake();
    expect(tokenCache.has(replacedToken)).toBe(false);
    expect(await streamUser(replacedToken)).toBeNull();

    tokenCache.set(activeToken, {
      user: { id: userId },
      expiry: Date.now() + 60_000
    });
    await request(app)
      .put(`/api/users/${userId}/stalker-devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(200);
    expect(tokenCache.has(activeToken)).toBe(false);
    expect(await streamUser(activeToken)).toBeNull();

    await request(app)
      .put(`/api/users/${userId}/stalker-devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true })
      .expect(200);
    const missingSessionToken = await handshake();
    db.prepare('DELETE FROM stalker_sessions WHERE token = ?').run(missingSessionToken);
    expect(await streamUser(missingSessionToken)).toBeNull();

    const expiredSessionToken = await handshake();
    tokenCache.set(expiredSessionToken, {
      user: { id: userId },
      expiry: Date.now() + 60_000
    });
    db.prepare('UPDATE stalker_sessions SET expires_at = ? WHERE token = ?')
      .run(Math.floor(Date.now() / 1000) - 1, expiredSessionToken);
    expect(await streamUser(expiredSessionToken)).toBeNull();
    expect(tokenCache.has(expiredSessionToken)).toBe(false);

    const deletedDeviceToken = await handshake();
    tokenCache.set(deletedDeviceToken, {
      user: { id: userId },
      expiry: Date.now() + 60_000
    });
    await request(app)
      .delete(`/api/users/${userId}/stalker-devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(tokenCache.has(deletedDeviceToken)).toBe(false);
    expect(await streamUser(deletedDeviceToken)).toBeNull();

    deviceId = (await registerDevice()).id;
    const mismatchedToken = await handshake();
    db.prepare('UPDATE stalker_sessions SET user_id = ? WHERE token = ?')
      .run(otherUserId, mismatchedToken);
    const mismatchedProfile = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', token: mismatchedToken });
    expect(mismatchedProfile.text).toBe('Authorization failed.');
    expect(mismatchedProfile.headers['cache-control']).toBe('no-store');
    expect(await streamUser(mismatchedToken)).toBeNull();

    const inactiveUserToken = await handshake();
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    expect(await streamUser(inactiveUserToken)).toBeNull();
    const inactiveProfile = await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', token: inactiveUserToken });
    expect(inactiveProfile.text).toBe('Authorization failed.');
    db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(userId);

    const regionToken = await handshake();
    db.prepare(`UPDATE users SET allowed_countries = 'DE' WHERE id = ?`).run(userId);
    expect(await streamUser(regionToken, '8.8.8.8')).toBeNull();
    const previousTrustProxy = app.get('trust proxy');
    app.set('trust proxy', 1);
    try {
      const blockedProfile = await request(app)
        .get('/server/load.php')
        .set('X-Forwarded-For', '8.8.8.8')
        .query({ type: 'stb', action: 'get_profile', token: regionToken });
      expect(blockedProfile.text).toBe('Authorization failed.');
    } finally {
      app.set('trust proxy', previousTrustProxy);
    }
    db.prepare('UPDATE users SET allowed_countries = NULL WHERE id = ?').run(userId);

    const expiredUserToken = await handshake();
    db.prepare('UPDATE users SET expiry_date = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 1, userId);
    expect(await streamUser(expiredUserToken)).toBeNull();

    const expiredHandshake = await request(app)
      .get('/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .query({ type: 'stb', action: 'handshake' });
    expect(expiredHandshake.text).toBe('Authorization failed.');
    expect(expiredHandshake.headers['cache-control']).toBe('no-store');
  });

  it('throttles session and device activity writes', async () => {
    const deviceId = (await registerDevice()).id;
    const token = await handshake();
    const now = Math.floor(Date.now() / 1000);
    const recent = now - 30;

    db.prepare('UPDATE stalker_sessions SET last_seen = ? WHERE token = ?').run(recent, token);
    db.prepare('UPDATE stalker_devices SET last_seen = ? WHERE id = ?').run(recent, deviceId);

    await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', token });
    expect(db.prepare('SELECT last_seen FROM stalker_sessions WHERE token = ?').get(token).last_seen).toBe(recent);
    expect(db.prepare('SELECT last_seen FROM stalker_devices WHERE id = ?').get(deviceId).last_seen).toBe(recent);

    const stale = now - 61;
    db.prepare('UPDATE stalker_sessions SET last_seen = ? WHERE token = ?').run(stale, token);
    db.prepare('UPDATE stalker_devices SET last_seen = ? WHERE id = ?').run(stale, deviceId);

    await request(app)
      .get('/server/load.php')
      .query({ type: 'stb', action: 'get_profile', token });
    expect(db.prepare('SELECT last_seen FROM stalker_sessions WHERE token = ?').get(token).last_seen).toBeGreaterThan(stale);
    expect(db.prepare('SELECT last_seen FROM stalker_devices WHERE id = ?').get(deviceId).last_seen).toBeGreaterThan(stale);
  });
});
