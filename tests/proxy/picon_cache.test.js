import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ db: { prepare: vi.fn(), exec: vi.fn() }, getXtreamUser: vi.fn(), getCachedImage: vi.fn(), clearImageCache: vi.fn(), fetchSafe: vi.fn(),
  manager: { add: vi.fn(async () => undefined), remove: vi.fn(), touch: vi.fn(), localStreams: new Map(),
    isSessionActive: vi.fn(), getUserConnectionCount: vi.fn(), getProviderConnectionCount: vi.fn() } }));
vi.mock('../../src/services/streamManager.js', () => ({ default: mocks.manager }));
vi.mock('../../src/database/db.js', () => ({ default: mocks.db }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: mocks.getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn(), getLogoCacheHash: () => 'hash', registerProviderCachedIcon: vi.fn() }));
vi.mock('../../src/services/imageCacheService.js', async importOriginal => ({ ...(await importOriginal()), getCachedImage: mocks.getCachedImage, clearImageCache: mocks.clearImageCache }));
vi.mock('../../src/middleware/auth.js', () => ({ authenticateToken: (req, res, next) => { req.user = { id: 1, is_admin: req.query.admin !== '0' }; next(); } }));
vi.mock('../../src/utils/network.js', async importOriginal => ({ ...(await importOriginal()), fetchSafe: mocks.fetchSafe }));

import router from '../../src/routes/proxy.js';
import { createClientResourceUrl } from '../../src/services/clientResourceService.js';

const user = { id: 1, is_active: 1, token_version: 0, webui_access: 0 };
let activeUser;
let providerPool;
const channel = { user_channel_id: 5, provider_id: 3, provider_url: 'https://provider.example', provider_max_connections: 1 };
const app = express();
app.use('/api/proxy/resource', express.raw({ type: () => true, limit: '1mb' }));
app.use('/api/proxy', router);
const reqForUrl = { protocol: 'http', get: () => '127.0.0.1', app: { get: () => false }, params: {}, query: {} };
const localPath = url => new URL(url).pathname + new URL(url).search;
const grant = (kind = 'image') => localPath(createClientResourceUrl(reqForUrl, user, 'https://provider.example/image.png', { kind }));
function response(body, contentType, status = 200) {
  return { ok: status < 400, status, url: 'https://upstream.example/path/resource',
    headers: new Headers({ 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }), body: Readable.from([Buffer.from(body)]) };
}

describe('client resource and image proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeUser = { ...user };
    providerPool = [{ id: 3, url: channel.provider_url, max_connections: 1 }];
    mocks.db.prepare.mockImplementation(sql => {
      if (sql.includes('FROM users')) return { get: () => activeUser };
      if (sql.includes('uc.granted_by_admin')) return { get: () => channel };
      if (sql.includes('url LIKE')) return { all: () => providerPool };
      return { get: () => ({ provider_id: 3 }) };
    });
    mocks.manager.isSessionActive.mockResolvedValue(false);
    mocks.manager.getUserConnectionCount.mockResolvedValue(0);
    mocks.manager.getProviderConnectionCount.mockResolvedValue(0);
    mocks.getXtreamUser.mockResolvedValue(user);
    mocks.getCachedImage.mockResolvedValue({ body: Buffer.from('cached-image'), contentType: 'image/png', cacheStatus: 'HIT' });
  });
  it('serves opaque image URLs without WebUI access and requires client revalidation', async () => {
    const res = await request(app).get(grant());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('cached-image');
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
  it('rejects tampered resource grants before fetching', async () => {
    expect((await request(app).get(grant().replace('/resource/', '/resource/modified'))).status).toBe(401);
    expect(mocks.getCachedImage).not.toHaveBeenCalled();
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });
  it('keeps legacy authenticated images working through the revalidating cache', async () => {
    mocks.getXtreamUser.mockResolvedValue({ ...user, webui_access: 1 });
    const res = await request(app).get('/api/proxy/image?url=https%3A%2F%2Fprovider.example%2Ficon.png&token=test');
    expect(res.status).toBe(200);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(mocks.getCachedImage).toHaveBeenCalledWith('https://provider.example/icon.png', expect.any(Object));
  });
  it('never forwards upstream errors or redirects', async () => {
    mocks.fetchSafe.mockResolvedValue(response('provider-password', 'text/html', 403));
    const res = await request(app).get(grant('resource'));
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).not.toContain('provider-password');
  });
  it('does not reuse compressed content length for an already decoded resource', async () => {
    const upstream = response('WEBVTT\n\ncomplete subtitle', 'text/vtt');
    upstream.headers.set('content-encoding', 'gzip');
    upstream.headers.set('content-length', '3');
    mocks.fetchSafe.mockResolvedValue(upstream);
    const res = await request(app).get(grant('resource'));
    expect(res.status).toBe(200);
    expect(res.text).toBe('WEBVTT\n\ncomplete subtitle');
  });
  it('validates images even when upstream metadata gave them a generic resource field', async () => {
    const upstream = response('<svg><image href="https://tracker.example/pixel"/></svg>', 'image/svg+xml');
    mocks.fetchSafe.mockResolvedValue(upstream);
    const res = await request(app).get(grant('resource'));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('cached-image');
    expect(mocks.getCachedImage).toHaveBeenCalled();
    expect(upstream.body.destroyed).toBe(true);
  });
  it('uses image compatibility headers on the initial generic probe and adopts its one-shot body', async () => {
    const upstream = response('one-shot-image', 'image/png');
    mocks.fetchSafe.mockImplementation(async (_url, options) => {
      const headers = new Headers(options.headers);
      return /Mozilla/.test(headers.get('user-agent') || '') && /image\//.test(headers.get('accept') || '')
        ? upstream : response('blocked', 'text/plain', 403);
    });
    mocks.getCachedImage.mockImplementationOnce(async (_url, options) => {
      expect(options.response).toBe(upstream);
      expect(options.response.body.destroyed).toBe(false);
      return { body: Buffer.from('one-shot-image'), contentType: 'image/png', cacheStatus: 'MISS' };
    });
    const res = await request(app).get(grant('resource'));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('one-shot-image');
    expect(mocks.fetchSafe).toHaveBeenCalledOnce();
  });
  it.each(['application/xml', 'text/css'])('blocks unsupported active documents with type %s', async type => {
    mocks.fetchSafe.mockResolvedValue(response('https://tracker.example/pixel', type));
    expect((await request(app).get(grant('resource'))).status).toBe(502);
  });
  it('rewrites nested HLS keys and segments', async () => {
    mocks.fetchSafe.mockResolvedValue(response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key"\nsegment.ts\n', 'application/vnd.apple.mpegurl'));
    const res = await request(app).get(grant('resource'));
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/provider\.example|keys\.example|upstream\.example/);
    expect(res.text.match(/\/api\/proxy\/resource\//g)).toHaveLength(2);
  });
  it('relays exact license POST bytes and encrypted upstream headers', async () => {
    const url = createClientResourceUrl(reqForUrl, user, 'https://drm.example/license', { kind: 'license', headers: { Authorization: 'Bearer provider-secret' } });
    mocks.fetchSafe.mockResolvedValue(response('license-response', 'application/octet-stream'));
    const res = await request(app).post(localPath(url)).set('Content-Type', 'application/octet-stream').send(Buffer.from([0, 1, 255]));
    expect(res.status).toBe(200);
    expect(mocks.fetchSafe.mock.calls[0][1]).toMatchObject({ method: 'POST', body: Buffer.from([0, 1, 255]), headers: expect.objectContaining({ Authorization: 'Bearer provider-secret' }) });
    expect(res.headers.authorization).toBeUndefined();
  });
  it('carries cookies from a nested manifest into its dependent resource grants', async () => {
    const child = response('#EXTM3U\nsegment.ts\n', 'application/vnd.apple.mpegurl');
    child.headers.set('set-cookie', 'session=rotated; Path=/; HttpOnly');
    mocks.fetchSafe.mockResolvedValue(child);
    const res = await request(app).get(grant('resource'));
    const segment = res.text.split('\n').find(line => line.startsWith('http'));
    mocks.fetchSafe.mockResolvedValue(response('segment', 'video/mp2t'));
    expect((await request(app).get(localPath(segment))).status).toBe(200);
    expect(new Headers(mocks.fetchSafe.mock.calls[1][1].headers).get('cookie')).toBe('session=rotated');
  });
  it('preserves encrypted cookie scopes through nested manifests and strips provider authorization from foreign hosts', async () => {
    const root = localPath(createClientResourceUrl(reqForUrl, user, 'https://panel.example.com/live/main.m3u8', {
      kind: 'resource', headers: { Cookie: 'initial=secret', Authorization: 'Bearer provider-secret' },
    }));
    const master = response('#EXTM3U\nchild.m3u8\nhttps://cdn.example.com/live/segment.ts\nhttps://license.example.net/key\n', 'application/vnd.apple.mpegurl');
    master.url = 'https://panel.example.com/live/main.m3u8';
    master.headers.getSetCookie = () => ['host=secret; Path=/', 'shared=yes; Domain=example.com; Path=/live; Secure'];
    mocks.fetchSafe.mockResolvedValueOnce(master);
    const result = await request(app).get(root);
    expect(result.status).toBe(200);
    expect(result.text).not.toMatch(/secret|example\.com|example\.net/);
    const urls = result.text.split('\n').filter(line => line.startsWith('http'));
    const child = response('#EXTM3U\nchunk.ts\nhttps://cdn.example.com/live/chunk.ts\n', 'application/vnd.apple.mpegurl');
    child.url = 'https://panel.example.com/live/child.m3u8';
    child.headers.set('set-cookie', 'host=; Max-Age=0; Path=/');
    mocks.fetchSafe.mockResolvedValueOnce(child);
    const childResult = await request(app).get(localPath(urls[0]));
    const nested = childResult.text.split('\n').filter(line => line.startsWith('http'));
    for (const url of [...nested, urls[1], urls[2]]) {
      mocks.fetchSafe.mockResolvedValueOnce(response('segment', 'video/mp2t'));
      expect((await request(app).get(localPath(url))).status).toBe(200);
    }
    const sent = mocks.fetchSafe.mock.calls.map(([, options]) => new Headers(options.headers));
    expect(sent[0].get('cookie')).toBe('initial=secret');
    expect(sent[1].get('cookie')).toContain('host=secret');
    expect(sent[2].get('cookie')).not.toContain('host=secret');
    expect(sent[2].get('authorization')).toBe('Bearer provider-secret');
    expect(sent[3].get('cookie')).toBe('shared=yes');
    expect(sent[3].get('authorization')).toBeNull();
    expect(sent[4].get('cookie')).toBe('shared=yes');
    expect(sent[5].get('cookie')).toBeNull();
    expect(sent[5].get('authorization')).toBeNull();
  });
  it.each(['assignment', 'share'])('revokes channel-bound licenses after removing the %s permission', async permission => {
    const url = localPath(createClientResourceUrl(reqForUrl, { ...user, resource_token: 'shared-token' }, 'https://drm.example/license', { kind: 'license', channelId: 5 }));
    mocks.getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [5] });
    mocks.fetchSafe.mockResolvedValue(response('license', 'application/octet-stream'));
    expect((await request(app).post(url).send('challenge')).status).toBe(200);
    expect(mocks.getXtreamUser).toHaveBeenCalledWith(expect.any(Object), { fresh: true });
    mocks.fetchSafe.mockClear();
    if (permission === 'share') {
      mocks.getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [6] });
    } else {
      const prepare = mocks.db.prepare.getMockImplementation();
      mocks.db.prepare.mockImplementation(sql => sql.includes('FROM authorized_user_channels') ? { get: () => undefined } : prepare(sql));
    }
    expect((await request(app).post(url).send('challenge')).status).toBe(401);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });
  it('retains channel scope through nested JSON license metadata', async () => {
    const url = localPath(createClientResourceUrl(reqForUrl, user, 'https://provider.example/metadata', { kind: 'resource', channelId: 5 }));
    mocks.fetchSafe.mockResolvedValue(response(JSON.stringify({ license_key: 'https://drm.example/license' }), 'application/json'));
    const metadata = await request(app).get(url);
    expect(metadata.status).toBe(200);
    const prepare = mocks.db.prepare.getMockImplementation();
    mocks.db.prepare.mockImplementation(sql => sql.includes('FROM authorized_user_channels') ? { get: () => undefined } : prepare(sql));
    mocks.fetchSafe.mockClear();
    expect((await request(app).post(localPath(metadata.body.license_key)).send('challenge')).status).toBe(401);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });
  it('rejects POST with an image grant', async () => {
    expect((await request(app).post(grant()).send('bad')).status).toBe(405);
    expect(mocks.getCachedImage).not.toHaveBeenCalled();
  });
  it('streams tracked media when add returns undefined and cleans up its heartbeat/session', async () => {
    const url = createClientResourceUrl(reqForUrl, user, 'https://provider.example/segment.m4s', {
      kind: 'resource', channelId: 5, channelName: 'Channel', providerId: 3
    });
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    const res = await request(app).get(localPath(url));
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('transport');
    expect(mocks.manager.add).toHaveBeenCalledOnce();
    expect(mocks.manager.touch).toHaveBeenCalled();
    expect(mocks.manager.remove).toHaveBeenCalledOnce();
    expect(mocks.manager.localStreams.size).toBe(0);
  });
  const mediaGrant = (providerId = 3) => localPath(createClientResourceUrl(reqForUrl, user, 'https://provider.example/segment.m4s', {
    kind: 'resource', channelId: 5, channelName: 'Channel', providerId
  }));
  it('denies a second channel when the user connection limit is reached before fetching', async () => {
    activeUser.max_connections = 1;
    mocks.manager.getUserConnectionCount.mockResolvedValue(1);
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    expect((await request(app).get(mediaGrant())).status).toBe(403);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
    expect(mocks.manager.add).not.toHaveBeenCalled();
  });
  it('denies a full bound provider instead of silently switching the grant to a sibling account', async () => {
    providerPool.push({ id: 4, url: channel.provider_url, max_connections: 10 });
    mocks.manager.getProviderConnectionCount.mockImplementation(async id => id === 3 ? 1 : 0);
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    expect((await request(app).get(mediaGrant())).status).toBe(403);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
    expect(mocks.manager.add).not.toHaveBeenCalled();
  });
  it('reuses the same active session at both limits for parallel segments', async () => {
    activeUser.max_connections = 1;
    mocks.manager.isSessionActive.mockResolvedValue(true);
    mocks.manager.getUserConnectionCount.mockResolvedValue(1);
    mocks.manager.getProviderConnectionCount.mockResolvedValue(1);
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    expect((await request(app).get(mediaGrant())).status).toBe(200);
    expect(mocks.manager.getProviderConnectionCount).not.toHaveBeenCalled();
  });
  it('accounts for the sibling provider encoded in the grant rather than the catalog provider', async () => {
    providerPool.push({ id: 4, url: channel.provider_url, max_connections: 2 });
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    expect((await request(app).get(mediaGrant(4))).status).toBe(200);
    expect(mocks.manager.add.mock.calls[0][5]).toBe(4);
    expect(mocks.manager.getProviderConnectionCount).toHaveBeenCalledWith(4);
  });
  it('rejects a grant if its provider account is no longer an authorized candidate', async () => {
    mocks.fetchSafe.mockResolvedValue(response('transport', 'video/mp4'));
    expect((await request(app).get(mediaGrant(99))).status).toBe(403);
    expect(mocks.fetchSafe).not.toHaveBeenCalled();
  });
  it('prunes only for administrators', async () => {
    mocks.clearImageCache.mockResolvedValue(3);
    expect((await request(app).delete('/api/proxy/picons?admin=0')).status).toBe(403);
    expect(mocks.clearImageCache).not.toHaveBeenCalled();
    expect((await request(app).delete('/api/proxy/picons')).body).toEqual({ deleted: 3 });
  });
});
