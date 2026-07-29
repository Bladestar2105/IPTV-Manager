import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import db, { initDb } from '../src/database/db.js';
import { generateToken, getXtreamUser, tokenCache } from '../src/services/authService.js';
import { migrateStalkerTables } from '../src/database/migrations.js';

describe('Stalker/MAG live TV flow', () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const mac = '02:00:00:00:06:09';
  let adminId;
  let adminToken;
  let userId;
  let providerId;
  let providerChannelId;
  let categoryId;
  let channelId;
  let deviceId;

  beforeAll(() => {
    initDb(true);
    migrateStalkerTables(db);
    migrateStalkerTables(db);

    db.prepare('DELETE FROM stalker_devices WHERE mac = ?').run(mac);

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
    providerId = Number(db.prepare(`
      INSERT INTO providers (name, url, username, password, user_id)
      VALUES (?, 'http://provider.invalid', 'upstream', 'unused', ?)
    `).run(`Stalker ${stamp}`, userId).lastInsertRowid);
    providerChannelId = Number(db.prepare(`
      INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
      VALUES (?, 609, 'Stalker Test Channel', 'live')
    `).run(providerId).lastInsertRowid);
    categoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type)
      VALUES (?, 'Live', 'live')
    `).run(userId).lastInsertRowid);
    channelId = Number(db.prepare(`
      INSERT INTO user_channels (user_category_id, provider_channel_id, granted_by_admin)
      VALUES (?, ?, 0)
    `).run(categoryId, providerChannelId).lastInsertRowid);
  });

  afterAll(() => {
    tokenCache.clear();
    if (userId) {
      db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(categoryId);
      db.prepare('DELETE FROM user_categories WHERE id = ?').run(categoryId);
      db.prepare('DELETE FROM provider_channels WHERE id = ?').run(providerChannelId);
      db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    }
    if (adminId) db.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId);
  });

  it('registers a MAC, lists channels, creates a scoped stream link, and revokes it', async () => {
    const created = await request(app)
      .post(`/api/users/${userId}/stalker-devices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mac });

    expect(created.status).toBe(201);
    expect(created.body.mac).toBe(mac);
    deviceId = created.body.id;

    const handshake = await request(app)
      .get('/server/load.php')
      .set('Cookie', `mac=${encodeURIComponent(mac)}`)
      .query({ type: 'stb', action: 'handshake' });

    expect(handshake.status).toBe(200);
    expect(handshake.body.js.token).toMatch(/^[0-9a-f]{64}$/);
    const token = handshake.body.js.token;

    const profile = await request(app)
      .get('/portal.php')
      .set('Authorization', `Bearer ${token}`)
      .query({ type: 'stb', action: 'get_profile' });
    expect(profile.body.js.name).toBe(`stalker_user_${stamp}`);

    const genres = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${token}`)
      .query({ type: 'itv', action: 'get_genres' });
    expect(genres.body.js.map(genre => genre.title)).toEqual(['All', 'Live']);

    const channels = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${token}`)
      .query({ type: 'itv', action: 'get_ordered_list', p: 0 });
    expect(channels.body.js.data).toEqual([
      expect.objectContaining({
        id: String(channelId),
        name: 'Stalker Test Channel',
        cmd: `ffmpeg http://localhost/ch/${channelId}_`
      })
    ]);

    const epg = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${token}`)
      .query({ type: 'itv', action: 'get_short_epg', ch_id: channelId });
    expect(epg.body.js).toEqual([]);

    const link = await request(app)
      .get('/server/load.php')
      .set('Authorization', `Bearer ${token}`)
      .query({
        type: 'itv',
        action: 'create_link',
        cmd: `ffmpeg http://localhost/ch/${channelId}_`
      });
    expect(link.body.js.cmd).toContain(`/live/token/auth/${channelId}.ts?token=`);

    const streamUser = await getXtreamUser({
      params: {},
      query: { token },
      headers: {},
      ip: '127.0.0.1'
    });
    expect(streamUser.id).toBe(userId);

    const disabled = await request(app)
      .put(`/api/users/${userId}/stalker-devices/${deviceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(disabled.body.enabled).toBe(0);

    const revokedUser = await getXtreamUser({
      params: {},
      query: { token },
      headers: {},
      ip: '127.0.0.1'
    });
    expect(revokedUser).toBeNull();

    const portal = await request(app).get('/c/');
    expect(portal.status).toBe(200);
    expect(portal.text).toContain('IPTV-Manager Stalker Portal');
  });
});
