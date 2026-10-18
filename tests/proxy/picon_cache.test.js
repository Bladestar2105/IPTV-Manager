import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ db: { prepare: vi.fn(), exec: vi.fn() }, getXtreamUser: vi.fn(), getCachedImage: vi.fn(), clearImageCache: vi.fn(), fetchSafe: vi.fn(),
  manager: { add: vi.fn(async () => undefined), remove: vi.fn(), touch: vi.fn(), localStreams: new Map() } }));
vi.mock('../../src/services/streamManager.js', () => ({ default: mocks.manager }));
vi.mock('../../src/database/db.js', () => ({ default: mocks.db }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: mocks.getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn(), getLogoCacheHash: () => 'hash', registerProviderCachedIcon: vi.fn() }));
vi.mock('../../src/services/imageCacheService.js', () => ({ getCachedImage: mocks.getCachedImage, clearImageCache: mocks.clearImageCache }));
vi.mock('../../src/middleware/auth.js', () => ({ authenticateToken: (req, res, next) => { req.user = { id: 1, is_admin: req.query.admin !== '0' }; next(); } }));
vi.mock('../../src/utils/network.js', async importOriginal => ({ ...(await importOriginal()), fetchSafe: mocks.fetchSafe }));

import router from '../../src/routes/proxy.js';
import { createClientResourceUrl } from '../../src/services/clientResourceService.js';

const user = { id: 1, is_active: 1, token_version: 0, webui_access: 0 };
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
    mocks.db.prepare.mockReturnValue({ get: () => user });
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
  it('prunes only for administrators', async () => {
    mocks.clearImageCache.mockResolvedValue(3);
    expect((await request(app).delete('/api/proxy/picons?admin=0')).status).toBe(403);
    expect(mocks.clearImageCache).not.toHaveBeenCalled();
    expect((await request(app).delete('/api/proxy/picons')).body).toEqual({ deleted: 3 });
  });
});
