import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const mocks = vi.hoisted(() => ({ fetchSafe: vi.fn(), getXtreamUser: vi.fn(), prepare: vi.fn(), cacheDir: '',
  manager: { localStreams: new Map(), add: vi.fn(), remove: vi.fn(), touch: vi.fn(), cleanupUser: vi.fn(), cleanupSession: vi.fn(),
    isSessionActive: vi.fn(), getUserConnectionCount: vi.fn(), getProviderConnectionCount: vi.fn() } }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: mocks.prepare } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: mocks.getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: () => null, getLogoCacheHash: () => 'image', registerProviderCachedIcon: vi.fn() }));
vi.mock('../../src/services/streamManager.js', () => ({ default: mocks.manager }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: mocks.fetchSafe }));
vi.mock('../../src/config/constants.js', async original => ({ ...(await original()), get CACHE_DIR() { return mocks.cacheDir; } }));

const { encrypt } = await import('../../src/utils/crypto.js');
const { proxySegment, proxyMpd, proxyTimeshift, proxyLive, proxyMovie } = await import('../../src/controllers/streamController.js');
const { reserveProviderSession } = await import('../../src/controllers/streamControllerHelpers.js');
const { default: router } = await import('../../src/routes/proxy.js');
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-segment-'));
afterAll(() => fs.rm(cacheDir, { recursive: true, force: true }));
const user = { id: 1, is_active: 1, token_version: 0, max_connections: 2 };
const channel = { user_channel_id: 1, provider_id: 3, name: 'Channel', provider_url: 'https://provider.example',
  provider_user: 'provider-user', provider_pass: encrypt('provider-pass'), remote_stream_id: 99,
  provider_max_connections: 2, provider_owner_id: 1, category_owner_id: 1, granted_by_admin: 0 };
const app = express();
app.get('/legacy/:username/:password/:filename', proxySegment);
app.get('/mpd/:stream_id/:mpdPath', proxyMpd);
app.get('/timeshift/:duration/:start/:stream_id', proxyTimeshift);
app.get('/live/:stream_id.ts', proxyLive);
app.get('/movie/:stream_id.mp4', proxyMovie);
app.use('/api/proxy', router);
const legacyUrl = (extra = {}) => `/legacy/user/pass/seg.ts?data=${encodeURIComponent(encrypt(JSON.stringify({
  u: 'https://provider.example/live/segment.ts', i: 1, ...extra,
})))}`;
const response = (body, type, status = 200) => ({ status, ok: status < 400, url: 'https://provider.example/live/segment.ts',
  headers: new Headers({ 'content-type': type }), body: Readable.from([body]) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheDir = cacheDir;
  user.max_connections = 2;
  user.is_active = 1;
  user.token_version = 0;
  mocks.manager.localStreams.clear();
  mocks.manager.add.mockReset();
  mocks.manager.remove.mockReset();
  mocks.manager.cleanupUser.mockReset();
  mocks.manager.cleanupSession.mockReset();
  mocks.getXtreamUser.mockResolvedValue(user);
  mocks.manager.isSessionActive.mockResolvedValue(false);
  mocks.manager.getUserConnectionCount.mockResolvedValue(0);
  mocks.manager.getProviderConnectionCount.mockResolvedValue(0);
  mocks.prepare.mockImplementation(sql => {
    if (sql.includes('FROM users')) return { get: () => user };
    if (sql.includes('stream_stats')) return { get: () => null, run: () => ({}) };
    if (sql.includes('url LIKE')) return { all: () => [{ id: 3, url: channel.provider_url, username: 'provider-user', password: channel.provider_pass, max_connections: 2 }] };
    return { get: () => ({ ...channel }) };
  });
});

describe('legacy HLS segments reuse the protected resource relay', () => {
  it('redirects old encrypted envelopes locally without contacting the provider', async () => {
    mocks.fetchSafe.mockResolvedValue(response('segment', 'video/mp2t'));
    const result = await request(app).get(legacyUrl());
    expect(result.status).toBe(307);
    expect(result.headers.location).toMatch(/^\/api\/proxy\/resource\//);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers.location).not.toMatch(/provider\.example|user\/pass/);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
    expect(mocks.getXtreamUser).toHaveBeenCalledWith(expect.any(Object), { fresh: true });
  });

  it.each(['user', 'provider', 'foreign-provider'])('rejects %s capacity or authorization before fetching even without legacy name/provider fields', async limit => {
    mocks.fetchSafe.mockResolvedValue(response('segment', 'video/mp2t'));
    if (limit === 'user') mocks.manager.getUserConnectionCount.mockResolvedValue(2);
    if (limit === 'provider') mocks.manager.getProviderConnectionCount.mockResolvedValue(2);
    const result = await request(app).get(legacyUrl(limit === 'foreign-provider' ? { p: 99, c: 'Channel' } : {})).redirects(1);
    expect(result.status).toBe(limit === 'foreign-provider' ? 401 : 403);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
    expect(mocks.manager.add).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'revoked-token', 'revoked-share'])('rechecks %s authorization after upgrading an old envelope', async revoked => {
    const upgrade = await request(app).get(`${legacyUrl()}&token=share-token`);
    expect(upgrade.status).toBe(307);
    if (revoked === 'disabled') user.is_active = 0;
    if (revoked === 'revoked-token') user.token_version = 1;
    if (revoked === 'revoked-share') mocks.getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [2] });
    expect((await request(app).get(upgrade.headers.location)).status).toBe(401);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });

  it.each([
    ['application/ttml+xml', '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body tts:backgroundImage="https://tracker.example/pixel"/></tt>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/pixel"/></svg>'],
    ['text/html', '<html><img src="https://tracker.example/pixel"></html>'],
    ['application/xml', '<document href="https://tracker.example/pixel"/>'],
    ['text/css', '@import "https://tracker.example/style.css";'],
  ])('rejects active dependency content %s through the legacy URL', async (type, body) => {
    mocks.fetchSafe.mockResolvedValue(response(body, type));
    const result = await request(app).get(legacyUrl()).redirects(1);
    expect(result.status).toBe(502);
    expect(result.text).not.toContain('tracker.example');
  });

  it('rewrites JSON dependencies through grants rather than returning upstream URLs', async () => {
    mocks.fetchSafe.mockResolvedValue(response(JSON.stringify({ subtitle: 'https://provider.example/captions.vtt' }), 'application/json'));
    const result = await request(app).get(legacyUrl()).redirects(1);
    expect(result.status).toBe(200);
    expect(result.body.subtitle).toContain('/api/proxy/resource/');
    expect(result.body.subtitle).not.toContain('provider.example');
  });

  it('preserves byte ranges, response status and tracked provider attribution', async () => {
    mocks.fetchSafe.mockImplementation((_url, options) => {
      const ranged = new Headers(options.headers).has('range');
      const bytes = ranged ? Buffer.from('chunk') : Buffer.concat([Buffer.alloc(100), Buffer.from('chunk'), Buffer.alloc(895)]);
      const upstream = response(bytes, 'video/mp4', ranged ? 206 : 200);
      upstream.headers.set('content-length', String(bytes.length));
      if (ranged) upstream.headers.set('content-range', 'bytes 100-104/1000');
      return upstream;
    });
    const result = await request(app).get(legacyUrl()).set('Range', 'bytes=100-104').redirects(1);
    expect(result.status).toBe(206);
    expect(result.headers['content-range']).toBe('bytes 100-104/1000');
    expect(new Headers(mocks.fetchSafe.mock.calls[0][1].headers).get('range')).toBe('bytes=100-104');
    expect(mocks.manager.add).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: 1 }), 'Channel', expect.any(String), expect.any(Object), 3, { dedupe: false });
  });

  it.each([
    ['/mpd/1/manifest.mpd', 'Channel (DASH)'],
    ['/timeshift/60/2026-10-18:10-00/1', 'Channel (Timeshift)'],
  ])('refreshes %s at connection capacity while its child session remains active', async (url, expectedName) => {
    user.max_connections = 1;
    mocks.fetchSafe.mockImplementation(async target => target.endsWith('/child.ts')
      ? response('segment', 'video/mp2t')
      : { ...response('#EXTM3U\nchild.ts\n', 'application/vnd.apple.mpegurl'), url: 'https://provider.example/live/master.m3u8' });
    const manifest = await request(app).get(url);
    expect(manifest.status).toBe(200);
    const child = manifest.text.split('\n').find(line => line.startsWith('http'));
    let activeName;
    mocks.manager.add.mockImplementation(async (_id, _user, name) => { activeName = name; });
    const childResult = await request(app).get(new URL(child).pathname);
    expect(childResult.status).toBe(200);
    mocks.manager.getUserConnectionCount.mockResolvedValue(1);
    mocks.manager.getProviderConnectionCount.mockResolvedValue(2);
    mocks.manager.isSessionActive.mockImplementation(async (_uid, _ip, name, providerId) => name === activeName && providerId === 3);
    const refreshed = await request(app).get(url);
    expect(refreshed.status).toBe(200);
    expect(activeName).toBe(expectedName);
    expect(refreshed.text).toContain('/api/proxy/resource/');
  });

  it.each([
    ['/mpd/1/manifest.mpd', 'Channel (DASH)'],
    ['/timeshift/60/2026-10-18:10-00/1', 'Channel (Timeshift)'],
    ['/live/1.ts', 'Channel'],
    ['/movie/1.mp4', 'Channel (VOD)'],
  ])('keeps active child responses alive during %s refresh with real stream deduplication', async (url, name) => {
    const { default: manager } = await vi.importActual('../../src/services/streamManager.js');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE current_streams (id TEXT PRIMARY KEY,user_id INTEGER,username TEXT,channel_name TEXT,start_time INTEGER,last_activity INTEGER,ip TEXT,worker_pid INTEGER,provider_id INTEGER)');
    manager.init(db, null);
    const destroyed = vi.fn();
    try {
      user.max_connections = 1;
      await manager.add('active-child', user, name, '::ffff:127.0.0.1', { destroy: destroyed }, 3, { dedupe: false });
      mocks.manager.add.mockImplementation((...args) => manager.add(...args));
      mocks.manager.remove.mockImplementation(id => manager.remove(id));
      mocks.manager.cleanupUser.mockImplementation((...args) => manager.cleanupUser(...args));
      mocks.manager.isSessionActive.mockImplementation((...args) => manager.isSessionActive(...args));
      mocks.manager.getUserConnectionCount.mockImplementation((...args) => manager.getUserConnectionCount(...args));
      mocks.manager.getProviderConnectionCount.mockImplementation((...args) => manager.getProviderConnectionCount(...args));
      mocks.fetchSafe.mockResolvedValue({ ...response('#EXTM3U\nchild.ts\n', 'application/vnd.apple.mpegurl'), url: 'https://provider.example/live/master.m3u8' });
      expect((await request(app).get(url)).status).toBe(200);
      expect(destroyed).not.toHaveBeenCalled();
      expect(db.prepare('SELECT id FROM current_streams WHERE id=?').get('active-child')).toBeTruthy();
    } finally {
      for (const id of [...manager.localStreams.keys()]) await manager.remove(id);
      manager.db = null;
      db.close();
    }
  });

  it.each([
    ['/timeshift/60/2026-10-18:10-00/1', 'Channel (Timeshift)'],
    ['/live/1.ts', 'Channel'], ['/movie/1.mp4', 'Channel (VOD)'],
  ])('deduplicates raw streams only after %s is known to return continuous media', async (url, name) => {
    const { default: manager } = await vi.importActual('../../src/services/streamManager.js');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE current_streams (id TEXT PRIMARY KEY,user_id INTEGER,username TEXT,channel_name TEXT,start_time INTEGER,last_activity INTEGER,ip TEXT,worker_pid INTEGER,provider_id INTEGER)');
    manager.init(db, null);
    const destroyed = vi.fn();
    try {
      await manager.add('old-stream', user, name, '::ffff:127.0.0.1', { destroy: destroyed }, 3, { dedupe: false });
      for (const method of ['add', 'remove', 'cleanupUser', 'cleanupSession', 'isSessionActive']) {
        mocks.manager[method].mockImplementation((...args) => manager[method](...args));
      }
      mocks.fetchSafe.mockImplementation(async () => {
        expect(destroyed).not.toHaveBeenCalled();
        return response('segment', 'video/mp2t');
      });
      expect((await request(app).get(url)).status).toBe(200);
      expect(destroyed).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT id FROM current_streams WHERE id=?').get('old-stream')).toBeUndefined();
    } finally {
      for (const id of [...manager.localStreams.keys()]) await manager.remove(id);
      manager.db = null;
      db.close();
    }
  });

  it('registers a series manifest alongside its existing child session without destroying it', async () => {
    const { default: manager } = await vi.importActual('../../src/services/streamManager.js');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE current_streams (id TEXT PRIMARY KEY,user_id INTEGER,username TEXT,channel_name TEXT,start_time INTEGER,last_activity INTEGER,ip TEXT,worker_pid INTEGER,provider_id INTEGER)');
    manager.init(db, null);
    const destroyed = vi.fn();
    try {
      const provider = { id: 3, url: channel.provider_url, max_connections: 2 };
      await manager.add('episode-child', user, 'Series S1 E1', '127.0.0.1', { destroy: destroyed }, 3, { dedupe: false });
      for (const method of ['add', 'remove', 'isSessionActive']) mocks.manager[method].mockImplementation((...args) => manager[method](...args));
      expect(await reserveProviderSession('manifest', user, provider, { ip: '127.0.0.1' }, {}, 'Series S1 E1', { dedupe: false })).toMatchObject({ id: 3 });
      expect(destroyed).not.toHaveBeenCalled();
    } finally {
      for (const id of [...manager.localStreams.keys()]) await manager.remove(id);
      manager.db = null;
      db.close();
    }
  });
});
