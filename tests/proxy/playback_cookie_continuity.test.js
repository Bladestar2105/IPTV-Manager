import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import pathModule from 'node:path';
import { rmSync } from 'node:fs';
const state = vi.hoisted(() => ({ fetchSafe: vi.fn(), dataDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'iptv-cookie-context-')) }));
vi.mock('../../src/config/constants.js', async original => ({ ...(await original()), DATA_DIR: state.dataDir, CACHE_DIR: require('node:path').join(state.dataDir, 'cache') }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: state.fetchSafe }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
import db, { initDb, DB_PATH } from '../../src/database/db.js';
import router from '../../src/routes/proxy.js';
import { persistPlaybackCookies } from '../../src/services/clientPlaybackContextService.js';
import { createUpstreamContext, withUpstreamCookies, upstreamRequestHeaders } from '../../src/utils/clientCookies.js';
import { createClientResourceUrl, resolveClientResource } from '../../src/services/clientResourceService.js';
const user = { id: 939393, token_version: 0, is_active: 1 };
const req = { protocol: 'http', get: () => 'manager.test', app: { get: () => false }, query: {}, params: {}, headers: {} };
const app = express(); app.use('/api/proxy', router);
const path = url => { const parsed = new URL(url); return parsed.pathname + parsed.search; };
const resolve = url => resolveClientResource({ ...req, params: { data: new URL(url).pathname.split('/')[4] } });
const response = (url, cookie) => ({ url, status: 200, ok: true, headers: new Headers({ 'content-type': 'application/octet-stream', ...(cookie ? { 'set-cookie': cookie } : {}) }), body: Readable.from(['good']) });
beforeAll(() => { initDb(true); db.prepare('INSERT OR REPLACE INTO users(id,username,password,is_active) VALUES(?,?,?,1)').run(user.id, 'cookie-continuity', 'unused'); });
afterAll(() => { db.close(); rmSync(state.dataDir, { recursive: true, force: true }); });
beforeEach(() => { state.fetchSafe.mockReset(); });
describe('mutable cookies within one opaque playback', () => {
  it('does not write catalog grants or unchanged cookie responses to SQLite', async () => {
    const writes = db.prepare('SELECT total_changes() AS count').get().count;
    let url;
    for (let index = 0; index < 100; index++) url = createClientResourceUrl(req, user, 'https://provider.example/media', { kind: 'resource', headers: { Cookie: 'session=A' } });
    state.fetchSafe.mockImplementation(async target => response(target, 'session=A; Path=/; Secure'));
    expect((await request(app).get(path(url))).status).toBe(200);
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(writes);
  });
  it('merges stale sibling-origin cookie updates and shares encrypted state with another worker process', async () => {
    const url = createClientResourceUrl(req, user, 'https://a.example.com/media', { kind: 'resource' });
    const root = await resolve(url);
    const a = withUpstreamCookies({}, response('https://a.example.com/media', 'a=one; Path=/; Secure'), root.url, root.cookieJar);
    const b = withUpstreamCookies({}, response('https://b.example.com/media', 'b=two; Path=/; Secure'), root.url, root.cookieJar);
    persistPlaybackCookies(root, root.cookieJar, a.cookieJar);
    persistPlaybackCookies(root, root.cookieJar, b.cookieJar);
    const latest = await resolve(url);
    expect(new Headers(upstreamRequestHeaders(latest, 'https://a.example.com/media')).get('cookie')).toBe('a=one');
    expect(new Headers(upstreamRequestHeaders(latest, 'https://b.example.com/media')).get('cookie')).toBe('b=two');
    const script = `import { resolveClientResource } from './src/services/clientResourceService.js';
      import { upstreamRequestHeaders } from './src/utils/clientCookies.js';
      const resource = await resolveClientResource({params:{data:${JSON.stringify(new URL(url).pathname.split('/')[4])}}, query:{}, headers:{}});
      console.log(JSON.stringify({cookie:upstreamRequestHeaders(resource,'https://b.example.com/media').Cookie}));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DATA_DIR: pathModule.dirname(DB_PATH) } });
    expect(JSON.parse(output.trim().split('\n').at(-1))).toEqual({ cookie: 'b=two' });
  });
  it('retains explicitly configured JSON license cookies alongside shared rotations', async () => {
    const root = createClientResourceUrl(req, user, 'https://panel.example.com/metadata', { kind: 'resource' });
    state.fetchSafe.mockImplementation(async target => ({ ...response(target, 'panel=rotated; Path=/; Secure'), headers: new Headers({ 'content-type': 'application/json', 'set-cookie': 'panel=rotated; Path=/; Secure' }), body: Readable.from([JSON.stringify({ license_key: 'https://drm.example/license|Cookie=license%3Dexplicit' })]) }));
    const result = await request(app).get(path(root));
    expect(result.status).toBe(200);
    const license = await resolve(result.body.license_key);
    expect(new Headers(upstreamRequestHeaders(license, license.url)).get('cookie')).toBe('license=explicit');
    state.fetchSafe.mockImplementation(async (target, options) => {
      expect(new Headers(options.headers).get('cookie')).toBe('license=explicit');
      return response(target, 'license=rotated; Path=/; Secure');
    });
    expect((await request(app).get(path(result.body.license_key))).status).toBe(200);
    const updated = await resolve(result.body.license_key);
    expect(new Headers(upstreamRequestHeaders(updated, updated.url)).get('cookie')).toBe('license=rotated');
  });
  it('isolates same-host explicit license-cookie overrides from the media session', async () => {
    const root = createClientResourceUrl(req, user, 'https://provider.example/metadata', { kind: 'resource' });
    state.fetchSafe.mockImplementation(async target => {
      const result = { ...response(target), headers: new Headers({ 'content-type': 'application/json' }), body: Readable.from([JSON.stringify({ license_key: 'https://provider.example/license|Cookie=session%3Ddrm' })]) };
      result.headers.append('Set-Cookie', 'session=panel; Path=/; Secure');
      result.headers.append('Set-Cookie', 'other=keep; Path=/; Secure');
      return result;
    });
    const metadata = await request(app).get(path(root));
    expect(metadata.status).toBe(200);
    const licenseUrl = metadata.body.license_key;
    let expected = 'drm';
    state.fetchSafe.mockImplementation(async (target, options) => {
      const cookies = new Headers(options.headers).get('cookie');
      if (!cookies.includes(`session=${expected}`) || !cookies.includes('other=keep')) return { ...response(target), ok: false, status: 401 };
      expected = 'renewed'; return response(target, 'session=renewed; Path=/; Secure');
    });
    expect((await request(app).get(path(licenseUrl))).status).toBe(200);
    expect((await request(app).get(path(licenseUrl))).status).toBe(200);
    const media = await resolve(root);
    const license = await resolve(licenseUrl);
    expect(license.playbackId).not.toBe(media.playbackId);
    expect(new Headers(upstreamRequestHeaders(media, media.url)).get('cookie')).toContain('session=panel');
    expect(new Headers(upstreamRequestHeaders(license, license.url)).get('cookie')).toContain('session=renewed');
  });
  it('retains standalone compact-license cookie rotations while preserving deduplication', async () => {
    const options = { kind: 'license', compact: true, headers: { Cookie: 'session=A' } };
    const first = createClientResourceUrl(req, user, 'https://provider.example/standalone-license', options);
    expect(createClientResourceUrl(req, user, 'https://provider.example/standalone-license', options)).toBe(first);
    const { shortLicenseRouter } = await import('../../src/routes/proxy.js');
    const compactApp = express(); compactApp.use('/r', shortLicenseRouter);
    let required = 'A';
    state.fetchSafe.mockImplementation(async (target, requestOptions) => {
      if (new Headers(requestOptions.headers).get('cookie') !== `session=${required}`) return { ...response(target), ok: false, status: 401 };
      required = 'B'; return response(target, 'session=B; Path=/; Secure');
    });
    expect((await request(compactApp).get(path(first))).status).toBe(200);
    expect((await request(compactApp).get(path(first))).status).toBe(200);
  });
  it('shares image-cache 304 cookie rotations with the media playback', async () => {
    const root = createClientResourceUrl(req, user, 'https://provider.example/media', { kind: 'resource', headers: { Cookie: 'session=A' } });
    const original = await resolve(root);
    const image = createClientResourceUrl(req, user, `https://provider.example/${original.playbackId}/poster.png`, { kind: 'image', playbackId: original.playbackId, headers: { Cookie: 'session=A' } });
    let calls = 0;
    state.fetchSafe.mockImplementation(async (target, options) => {
      if (target.endsWith('/poster.png')) {
        calls++;
        if (calls === 1) return { ...response(target), headers: new Headers({ 'content-type': 'image/png', etag: '"image"' }) };
        expect(new Headers(options.headers).get('if-none-match')).toBe('"image"');
        return { ...response(target, 'session=B; Path=/; Secure'), status: 304 };
      }
      if (new Headers(options.headers).get('cookie') !== 'session=B') return { ...response(target), ok: false, status: 401 };
      return response(target);
    });
    expect((await request(app).get(path(image))).status).toBe(200);
    expect((await request(app).get(path(image))).headers['x-cache']).toBe('HIT');
    expect((await request(app).get(path(root))).status).toBe(200);
  });
  it('persists 206 probe and final-refetch cookie rotations even without DRM metadata', async () => {
    const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16); ftyp.write('ftyp', 4); ftyp.write('isom0000', 8);
    const mdat = Buffer.alloc(64, 3); mdat.writeUInt32BE(64); mdat.write('mdat', 4);
    const media = Buffer.concat([ftyp, mdat]);
    const url = createClientResourceUrl(req, user, 'https://provider.example/range.mp4', { kind: 'resource', headers: { Cookie: 'session=0' } });
    let generation = 0;
    state.fetchSafe.mockImplementation(async (target, options) => {
      const context = createUpstreamContext(options.headers, target, options.cookieJar, options.headerOrigin);
      const headers = new Headers(upstreamRequestHeaders(context, target));
      if (headers.get('cookie') !== `session=${generation}`) return { ...response(target), ok: false, status: 401 };
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range'));
      const result = { url: target, status: 206, ok: true,
        headers: new Headers({ 'content-type': 'video/mp4', 'etag': '"stable"', 'content-range': `bytes ${start}-${end}/${media.length}`, 'content-length': String(Number(end)-Number(start)+1), 'set-cookie': `session=${++generation}; Path=/; Secure` }),
        body: Readable.from([media.subarray(Number(start), Number(end)+1)]) };
      result.upstreamCookieJar = withUpstreamCookies(context.headers, result, target, context.cookieJar, context.headerOrigin).cookieJar;
      return result;
    });
    for (let index = 0; index < 2; index++) {
      const result = await request(app).get(path(url)).set('Range', 'bytes=24-31');
      expect(result.status).toBe(206);
      expect(result.body).toEqual(media.subarray(24, 32));
    }
    expect(generation).toBeGreaterThan(4);
  });
  it('uses rotated media and license cookies for the next Range and sibling resource while isolating fresh playbacks', async () => {
    const root = createClientResourceUrl(req, user, 'https://provider.example/media', { kind: 'resource', headers: { Cookie: 'session=A' } });
    const original = await resolve(root);
    const sibling = createClientResourceUrl(req, user, 'https://provider.example/sibling', { kind: 'resource', headers: { Cookie: 'session=A' }, playbackId: original.playbackId });
    const license = createClientResourceUrl(req, user, 'https://provider.example/license', { kind: 'license', headers: original.headers, cookieJar: original.cookieJar, headerOrigin: original.headerOrigin, playbackId: original.playbackId });
    let required = 'A';
    state.fetchSafe.mockImplementation(async (target, options) => {
      if (new Headers(options.headers).get('cookie') !== `session=${required}`) return { ...response(target), ok: false, status: 401 };
      if (target.endsWith('/media')) { required = 'B'; return response(target, 'session=B; Path=/; Secure'); }
      if (target.endsWith('/license')) { required = 'C'; return response(target, 'session=C; Path=/; Secure'); }
      return response(target);
    });
    expect((await request(app).get(path(root))).status).toBe(200);
    expect((await request(app).get(path(root)).set('Range', 'bytes=0-3')).status).toBe(200);
    expect((await request(app).get(path(license))).status).toBe(200);
    expect((await request(app).get(path(sibling))).status).toBe(200);
    const fresh = createClientResourceUrl(req, user, 'https://provider.example/media', { kind: 'resource', headers: { Cookie: 'session=A' } });
    expect((await resolve(fresh)).playbackId).not.toBe(original.playbackId);
    required = 'A';
    expect((await request(app).get(path(fresh))).status).toBe(200);
    const rows = db.prepare('SELECT envelope FROM client_playback_contexts').all();
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/session|provider.example/);
  });
});
