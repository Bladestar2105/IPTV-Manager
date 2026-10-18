import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
const state = vi.hoisted(() => ({ fetchSafe: vi.fn(), prepare: vi.fn() }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: state.prepare, transaction: callback => ({ immediate: callback }) } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: vi.fn() }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: () => null, getLogoCacheHash: () => '', registerProviderCachedIcon: vi.fn() }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: state.fetchSafe }));
import router from '../../src/routes/proxy.js';
import { upstreamRequestHeaders } from '../../src/utils/clientCookies.js';
import { createClientResourceUrl, resolveClientResource } from '../../src/services/clientResourceService.js';
const user = { id: 7, token_version: 0, is_active: 1 };
const req = { protocol: 'http', get: () => 'manager.test', app: { get: () => false }, query: {}, params: {} };
const app = express(); app.use('/api/proxy', router);
const response = (url, body, type = 'application/octet-stream', status = 200) => ({ url, status, ok: status < 300, headers: new Headers({ 'content-type': type }), body: Readable.from([body]) });
const path = url => { const parsed = new URL(url); return parsed.pathname + parsed.search; };
beforeEach(() => {
  vi.clearAllMocks();
  state.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : undefined, run: () => ({}) }));
});
describe('DASH CDN grants through the real proxy route', () => {
  it.each(['status', 'network'])('falls back on %s failures with range and origin-scoped credentials', async failure => {
    const url = createClientResourceUrl(req, user, 'https://a.example/seg', { kind: 'resource', headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' }, alternatives: ['https://b.example/seg'] });
    state.fetchSafe.mockImplementation(async (target, options) => {
      const headers = new Headers(options.headers);
      expect(headers.get('range')).toBe('bytes=0-3');
      if (target.includes('a.example')) {
        expect(headers.get('authorization')).toBe('Bearer secret');
        if (failure === 'network') throw new Error('connect failed');
        return response(target, 'failed', 'text/plain', 503);
      }
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      return response(target, 'good');
    });
    const result = await request(app).get(path(url)).set('Range', 'bytes=0-3');
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('good');
    expect(state.fetchSafe).toHaveBeenCalledTimes(2);
  });
  it('rewrites nested interstitial asset-list JSON URIs through Manager grants', async () => {
    const url = createClientResourceUrl(req, user, 'https://cdn.example/ads.json?password=private', { kind: 'resource' });
    state.fetchSafe.mockImplementation(async target => response(target, JSON.stringify({ ASSETS: [{ URI: 'ad.m3u8?password=private', DURATION: 30 }] }), 'application/json'));
    const result = await request(app).get(path(url));
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toMatch(/cdn\.example|password=private/);
    expect(result.body.ASSETS[0].DURATION).toBe(30);
    const child = new URL(result.body.ASSETS[0].URI);
    expect(await resolveClientResource({ ...req, params: { data: child.pathname.split('/')[4] }, headers: {} })).toMatchObject({ url: 'https://cdn.example/ad.m3u8?password=private' });
  });
  it('retains domain cookies from failed candidates without leaking host-only cookies', async () => {
    const url = createClientResourceUrl(req, user, 'https://a.example.com/seg', { kind: 'resource', alternatives: ['https://b.example.com/seg'] });
    state.fetchSafe.mockImplementation(async (target, options) => {
      if (target.includes('a.example.com')) {
        const failed = response(target, 'failed', 'text/plain', 503);
        failed.headers.append('Set-Cookie', 'shared=refreshed; Domain=example.com; Path=/; Secure');
        failed.headers.append('Set-Cookie', 'host=private; Path=/; Secure');
        return failed;
      }
      expect(new Headers(options.headers).get('cookie')).toBe('shared=refreshed');
      return response(target, '#EXTM3U\nseg.ts', 'application/vnd.apple.mpegurl');
    });
    const result = await request(app).get(path(url));
    expect(result.status).toBe(200);
    const child = new URL(result.text.split('\n').at(-1));
    const resolved = await resolveClientResource({ ...req, params: { data: child.pathname.split('/')[4] }, headers: {} });
    const headers = upstreamRequestHeaders(resolved, resolved.url);
    expect(new Headers(headers).get('cookie')).toBe('shared=refreshed');
  });
  it('retains remaining manifest bases when resolving nested XLink templates', async () => {
    const url = createClientResourceUrl(req, user, 'https://a.example/child', { kind: 'resource', manifestKind: 'dash', alternatives: ['https://b.example/child'] });
    state.fetchSafe.mockImplementation(async target => response(target, '<Period><SegmentTemplate media="seg-$Number$.m4s"/></Period>', 'application/dash+xml'));
    const result = await request(app).get(path(url));
    expect(result.status).toBe(200);
    expect(result.text).not.toMatch(/[ab]\.example/);
    const child = new URL(result.text.match(/media="([^"]+)"/)[1].replaceAll('&amp;', '&'));
    const resolved = await resolveClientResource({ ...req, params: { data: child.pathname.split('/')[4] }, query: { tpl0: '18' }, headers: {} });
    expect(resolved).toMatchObject({ url: 'https://a.example/seg-18.m4s', alternatives: ['https://b.example/seg-18.m4s'] });
  });
});
