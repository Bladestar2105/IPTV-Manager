import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/services/streamManager.js', () => ({ default: { getUserConnectionCount: vi.fn(async () => 0) } }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: vi.fn() }));
const dataDir = mkdtempSync(join(tmpdir(), 'iptv-player-contract-'));
process.env.DATA_DIR = dataDir;
const { default: db, initDb } = await import('../../src/database/db.js');
const { playerApi } = await import('../../src/controllers/xtreamPlayerApiController.js');
const { playerChannelsJson } = await import('../../src/controllers/xtreamController.js');
const { channelsJsonCache } = await import('../../src/services/cacheService.js');
const { providerSourceKey } = await import('../../src/utils/helpers.js');
const { encrypt } = await import('../../src/utils/crypto.js');
const { fetchSafe } = await import('../../src/utils/network.js');
const { authCache, getXtreamUser } = await import('../../src/services/authService.js');
const app = express();
app.set('trust proxy', true);
app.get('/player_api.php', playerApi);
app.get('/api/player/channels.json', playerChannelsJson);
app.get(['/live/:username/:password/:id', '/movie/:username/:password/:id', '/series/:username/:password/:id', '/live/mpd/:username/:password/:id/manifest.mpd'], async (req, res) => {
  const user = await getXtreamUser(req);
  res.status(user ? 200 : 401).json({ user_id: user?.id });
});
const credentials = { username: 'contract-user', password: 'contract-password' };
const get = query => request(app).get('/player_api.php').query({ ...credentials, ...query });

describe('Xtream player contract with real catalog assignments', () => {
  let userId;
  const assignments = {};
  beforeAll(() => {
    initDb(true);
    userId = Number(db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(credentials.username, encrypt(credentials.password)).lastInsertRowid);
    const providerId = Number(db.prepare("INSERT INTO providers(name,url,username,password,user_id) VALUES('Contract','https://panel.test','provider',?,?)").run(encrypt('secret'), userId).lastInsertRowid);
    for (const type of ['live', 'movie', 'series']) {
      const categoryId = Number(db.prepare('INSERT INTO user_categories(user_id,name,type) VALUES(?,?,?)').run(userId, type, type).lastInsertRowid);
      const channelId = Number(db.prepare('INSERT INTO provider_channels(provider_id,remote_stream_id,name,stream_type,original_category_id,mime_type,metadata) VALUES(?,?,?,?,900,?,?)')
        .run(providerId, 555 + Object.keys(assignments).length, type, type, 'video/mp4', JSON.stringify({ last_modified: '1700000000' })).lastInsertRowid);
      const id = Number(db.prepare('INSERT INTO user_channels(user_category_id,provider_channel_id) VALUES(?,?)').run(categoryId, channelId).lastInsertRowid);
      assignments[type] = { id, categoryId, channelId };
    }
    for (const episode of [123, 124]) {
      db.prepare(`INSERT INTO provider_series_episodes(source_key,series_remote_id,remote_episode_id,season,episode_num,title,container_extension)
        VALUES(?,?,?,1,?,?,'mp4')`).run(providerSourceKey('https://panel.test'), 557, episode, episode - 122, `Episode ${episode}`);
    }
  });
  beforeEach(() => {
    channelsJsonCache.clear();
    db.prepare('DELETE FROM series_episode_aliases').run();
    vi.clearAllMocks();
    authCache.clear();
    db.prepare('UPDATE users SET expiry_date=NULL WHERE id=?').run(userId);
    fetchSafe.mockResolvedValue({ ok: true, json: async () => ({
      info: { category_id: '900', category_ids: [900] },
      movie_data: { stream_id: 555, container_extension: 'video/mp4', category_id: '900', category_ids: [900] },
    }) });
  });
  afterAll(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

  it.each([undefined, 'get_profile', 'get_server_info'])('supports profile metadata action %s using the external TLS origin', async action => {
    const response = await get(action ? { action } : {}).set('X-Forwarded-Proto', 'https').set('X-Forwarded-Host', 'manager.example:8443');
    expect(response.status).toBe(200);
    expect(response.body.user_info).toMatchObject({ auth: 1, exp_date: null });
    expect(response.body.server_info).toMatchObject({ url: 'manager.example', port: '8443', https_port: '8443', server_protocol: 'https', timezone: 'UTC' });
    expect(response.body.server_info.time_now).toBe(new Date(response.body.server_info.timestamp_now * 1000).toISOString().slice(0, 19).replace('T', ' '));
  });

  it.each(['2030-01-01', 1893456000, 1893456000000])('reports the same expiry for %s', async expiry => {
    db.prepare('UPDATE users SET expiry_date=? WHERE id=?').run(expiry, userId);
    expect((await get({})).body.user_info.exp_date).toBe('1893456000');
  });

  it.each(['live', 'series'])('rejects a %s assignment requested as movie details', async type => {
    expect((await get({ action: 'get_vod_info', vod_id: assignments[type].id })).body).toEqual({});
    expect(fetchSafe).not.toHaveBeenCalled();
  });

  it('maps movie details to local categories and normalizes the extension', async () => {
    const { id, categoryId } = assignments.movie;
    const payload = (await get({ action: 'get_vod_info', vod_id: id })).body;
    expect(payload.movie_data).toMatchObject({ stream_id: id, category_id: String(categoryId), category_ids: [categoryId], container_extension: 'mp4' });
    expect(payload.info).toMatchObject({ category_id: String(categoryId), category_ids: [categoryId] });
  });

  it('maps series details to local categories', async () => {
    const { id, categoryId } = assignments.series;
    const payload = (await get({ action: 'get_series_info', series_id: id })).body;
    expect(payload.info).toMatchObject({ category_id: String(categoryId), category_ids: [categoryId] });
  });

  it('preserves upstream series changes and keeps missing modification times stable', async () => {
    expect((await get({ action: 'get_series' })).body[0].last_modified).toBe('1700000000');
    db.prepare('UPDATE provider_channels SET metadata=?,added=NULL WHERE id=?').run('{}', assignments.series.channelId);
    const first = (await get({ action: 'get_series' })).body[0].last_modified;
    expect(first).toBe('');
    expect((await get({ action: 'get_series' })).body[0].last_modified).toBe(first);
  });
  it.each(['live', 'movie'])('builds only the requested %s catalog without expanding series', async type => {
    const response = await request(app).get('/api/player/channels.json').query({ ...credentials, type, series: 'summary' });
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].type).toBe(type);
    expect(db.prepare('SELECT COUNT(*) AS count FROM series_episode_aliases').get().count).toBe(0);
  });

  it('returns one local series folder and defers episode aliases until details are opened', async () => {
    const response = await request(app).get('/api/player/channels.json').query({ ...credentials, type: 'series', series: 'summary' });
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ type: 'series', series_id: assignments.series.id, name: 'series', url: '' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM series_episode_aliases').get().count).toBe(0);
  });

  it('retains expanded companion defaults and isolates catalog cache modes', async () => {
    const getCatalog = query => request(app).get('/api/player/channels.json').query({ ...credentials, ...query });
    const expanded = (await getCatalog({})).body;
    expect(expanded).toHaveLength(4);
    expect(expanded.filter(row => row.type === 'series')).toHaveLength(2);
    const summary = (await getCatalog({ series: 'summary' })).body;
    expect(summary).toHaveLength(3);
    expect(summary.find(row => row.type === 'series').series_id).toBe(assignments.series.id);
    expect((await getCatalog({ type: 'live' })).body).toHaveLength(1);
    expect((await getCatalog({})).body).toHaveLength(4);
  });

  it('returns playable live, movie, DASH and expanded episode URLs for credential login', async () => {
    for (const extension of ['video/mp4', 'application/dash+xml']) {
      db.prepare('UPDATE provider_channels SET mime_type=? WHERE id=?').run(extension, assignments.live.channelId);
      channelsJsonCache.clear();
      const response = await request(app).get('/api/player/channels.json').query(credentials);
      expect(response.body).toHaveLength(4);
      for (const channel of response.body) {
        const url = new URL(channel.url);
        expect((await request(app).get(url.pathname + url.search)).body.user_id).toBe(userId);
      }
    }
  });

  it('encodes credential path components and isolates token and credential cache entries', async () => {
    const special = { username: 'contract/ümlaut?#&', password: 'p/a?&%+ß#' };
    db.prepare('UPDATE users SET username=?,password=? WHERE id=?').run(special.username, encrypt(special.password), userId);
    db.prepare('INSERT INTO temporary_tokens(token,user_id,expires_at) VALUES(?,?,?)').run('catalog-auth-token', userId, Math.floor(Date.now() / 1000) + 300);
    try {
      const query = { type: 'movie' };
      const getCatalog = auth => request(app).get('/api/player/channels.json').set('Host', 'manager.test').query({ ...auth, ...query });
      const credentialCatalog = await getCatalog(special);
      const credentialUrl = new URL(credentialCatalog.body[0].url);
      expect(credentialUrl.pathname).toContain(`/${encodeURIComponent(special.username)}/${encodeURIComponent(special.password)}/`);
      expect((await request(app).get(credentialUrl.pathname)).body.user_id).toBe(userId);
      const tokenCatalog = await getCatalog({ token: 'catalog-auth-token' });
      const tokenUrl = new URL(tokenCatalog.body[0].url);
      expect(tokenUrl.pathname).toContain('/token/auth/');
      expect(tokenUrl.searchParams.get('token')).toBe('catalog-auth-token');
      expect((await request(app).get(tokenUrl.pathname + tokenUrl.search)).body.user_id).toBe(userId);
      expect((await getCatalog(special)).body[0].url).toBe(credentialUrl.href);
    } finally {
      db.prepare('UPDATE users SET username=?,password=? WHERE id=?').run(credentials.username, encrypt(credentials.password), userId);
      db.prepare('DELETE FROM temporary_tokens WHERE token=?').run('catalog-auth-token');
      authCache.clear();
    }
  });

  it('retains current share scope in typed summaries and rejects invalid catalog selectors', async () => {
    db.prepare('INSERT INTO shared_links(token,user_id,channels) VALUES(?,?,?)').run('summary-share', userId, JSON.stringify([assignments.live.id]));
    const response = await request(app).get('/api/player/channels.json').query({ token: 'summary-share', type: 'series', series: 'summary' });
    expect(response.body).toEqual([]);
    expect((await request(app).get('/api/player/channels.json').query({ ...credentials, type: 'invalid' })).status).toBe(400);
  });

  it.each([null, ''])('includes legacy channels with type %s in the live catalog', async type => {
    db.prepare('UPDATE provider_channels SET stream_type=? WHERE id=?').run(type, assignments.live.channelId);
    const response = await request(app).get('/api/player/channels.json').query({ ...credentials, type: 'live' });
    expect(response.body).toHaveLength(1);
    expect(response.body[0].type).toBe('live');
  });

});
