import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import db, { initDb } from '../src/database/db.js';
import { generateToken, getXtreamUser, tokenCache } from '../src/services/authService.js';
import { migrateStalkerTables } from '../src/database/migrations.js';

describe('Stalker/MAG live TV flow', () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const mac = '02:00:00:00:06:09';
  const authorizedChannelIds = [];
  const hiddenChannelIds = [];
  const unauthorizedChannelIds = [];
  let adminId;
  let adminToken;
  let userId;
  let otherUserId;
  let providerId;
  let otherProviderId;
  let categoryId;
  let secondCategoryId;

  const streamUser = token => getXtreamUser({
    params: {},
    query: { token },
    headers: {},
    ip: '127.0.0.1'
  });

  async function registerDevice() {
    const response = await request(app)
      .post(`/api/users/${userId}/stalker-devices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mac });
    expect(response.status).toBe(201);
    return response.body.id;
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
      VALUES (?, 'http://provider.invalid', 'upstream', 'unused', ?)
    `).run(`Stalker ${stamp}`, userId).lastInsertRowid);
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

    const insertProviderChannel = db.prepare(`
      INSERT INTO provider_channels (
        provider_id, remote_stream_id, name, stream_type, original_sort_order
      ) VALUES (?, ?, ?, 'live', ?)
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
          index
        ).lastInsertRowid);
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
          10_000 + index
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
          20_000 + index
        ).lastInsertRowid);
        unauthorizedChannelIds.push(Number(insertUserChannel.run(
          categoryId,
          unauthorizedProviderChannelId,
          20_000 + index,
          0
        ).lastInsertRowid));
      }
    })();
  });

  beforeEach(() => {
    tokenCache.clear();
    db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(userId);
    db.prepare('UPDATE users SET is_active = 1, expiry_date = NULL WHERE id = ?').run(userId);
  });

  afterAll(() => {
    tokenCache.clear();
    if (userId) {
      db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_channels WHERE user_category_id IN (?, ?)').run(categoryId, secondCategoryId);
      db.prepare('DELETE FROM user_categories WHERE id IN (?, ?)').run(categoryId, secondCategoryId);
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

    const genres = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${activeToken}`)
      .query({ type: 'itv', action: 'get_genres' });
    expect(genres.body.js.map(genre => genre.title)).toEqual(['All', 'Live A', 'Live B']);

    const forbiddenIds = new Set([...hiddenChannelIds, ...unauthorizedChannelIds].map(String));
    const listedIds = new Set();
    const expectedPageSizes = [100, 100, 53];
    for (let page = 0; page < expectedPageSizes.length; page += 1) {
      const response = await request(app)
        .get('/server/load.php')
        .set('Authorization', `Bearer ${activeToken}`)
        .query({ type: 'itv', action: 'get_ordered_list', p: page });
      expect(response.body.js).toMatchObject({
        total_items: '253',
        max_page_items: 100,
        cur_page: page
      });
      expect(response.body.js.data).toHaveLength(expectedPageSizes[page]);
      response.body.js.data.forEach(channel => {
        expect(forbiddenIds.has(channel.id)).toBe(false);
        expect(listedIds.has(channel.id)).toBe(false);
        listedIds.add(channel.id);
      });
    }
    expect(listedIds).toEqual(new Set(authorizedChannelIds.map(String)));

    const categoryPage0 = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: categoryId,
        p: 0
      });
    const categoryPage1 = await request(app)
      .get('/server/load.php')
      .query({
        type: 'itv',
        action: 'get_ordered_list',
        token: activeToken,
        genre: categoryId,
        p: 1
      });
    expect(categoryPage0.body.js.total_items).toBe('150');
    expect(categoryPage0.body.js.data).toHaveLength(100);
    expect(categoryPage1.body.js.data).toHaveLength(50);
    expect([...categoryPage0.body.js.data, ...categoryPage1.body.js.data]
      .every(channel => channel.tv_genre_id === String(categoryId))).toBe(true);

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
      cur_page: 0
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

    expect((await streamUser(activeToken)).id).toBe(userId);
    expect(tokenCache.has(activeToken)).toBe(false);

    const portal = await request(app).get('/c/');
    expect(portal.status).toBe(200);
    expect(portal.text).toContain('data-i18n="stalkerPortalPageTitle"');
  });

  it('revokes replaced, disabled, deleted, missing, and expired sessions immediately', async () => {
    let deviceId = await registerDevice();
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
    db.prepare('UPDATE stalker_sessions SET expires_at = ? WHERE token = ?')
      .run(Math.floor(Date.now() / 1000) - 1, expiredSessionToken);
    expect(await streamUser(expiredSessionToken)).toBeNull();

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

    deviceId = await registerDevice();
    const expiredUserToken = await handshake();
    db.prepare('UPDATE users SET expiry_date = ? WHERE id = ?')
      .run(Math.floor(Date.now() / 1000) - 1, userId);
    expect(await streamUser(expiredUserToken)).toBeNull();

    const expiredHandshake = await request(app)
      .get('/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .query({ type: 'stb', action: 'handshake' });
    expect(expiredHandshake.text).toBe('Authorization failed.');
  });

  it('throttles session and device activity writes', async () => {
    const deviceId = await registerDevice();
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
