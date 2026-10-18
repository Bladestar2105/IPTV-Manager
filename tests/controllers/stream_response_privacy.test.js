import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';

const state = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: async () => ({ id: 1 }) }));
vi.mock('../../src/services/streamManager.js', () => ({ default: { localStreams: new Map(), remove: vi.fn(), touch: vi.fn(), cleanupSession: vi.fn() } }));
vi.mock('../../src/services/clientResourceService.js', () => ({ createClientResourceUrl: () => 'http://manager.example/api/proxy/resource/safe/resource' }));
vi.mock('../../src/utils/crypto.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: state.fetchSafe }));
vi.mock('../../src/controllers/streamControllerHelpers.js', async original => ({
  ...(await original()),
  getChannel: () => ({ user_channel_id: 1, provider_id: 3, provider_url: 'https://provider.example', provider_user: 'u', provider_pass: 'p', remote_stream_id: 99, name: 'Channel', mime_type: 'mp4' }),
  getSeriesEpisode: () => ({ id: 3, url: 'https://provider.example', username: 'u', password: 'p', user_channel_id: 1, remote_episode_id: 99, series_name: 'Series', container_extension: 'mp4' }),
  buildStreamHeaders: () => ({ headers: {}, meta: {} }), buildBackupUrls: () => [],
  reserveChannelSession: async () => true,
  reserveProviderSession: async (_id, _user, provider) => provider,
  shareGuestAllowed: () => true, recordStreamStat: vi.fn(), createSafeCleanup: () => vi.fn(),
}));

const controllers = await import('../../src/controllers/streamController.js');
const app = express();
app.get('/live/:stream_id.ts', controllers.proxyLive);
app.get('/mpd/:stream_id/:mpdPath', controllers.proxyMpd);
app.get('/timeshift/:duration/:start/:stream_id', controllers.proxyTimeshift);
app.get('/movie/:stream_id.mp4', controllers.proxyMovie);
app.get('/series/:episode_id.mp4', controllers.proxySeries);
const paths = ['/live/1.ts', '/mpd/1/chunk.bin', '/timeshift/60/2026-10-18:10-00/1', '/movie/1.mp4', '/series/1.mp4'];
const response = (body, type, status = 200) => ({ url: 'https://provider.example/raw', status, ok: true,
  headers: new Headers({ 'content-type': type }), body: Readable.from([body]) });
beforeEach(() => state.fetchSafe.mockReset());

describe.each(paths)('initial stream privacy for %s', url => {
  it.each(['text/html', 'application/xml', 'text/css', 'application/json', 'image/svg+xml', 'application/javascript'])('rejects provider error documents returned as %s', async type => {
    const body = type === 'application/json' ? JSON.stringify({ error: 'https://provider.example/private?password=secret' }) : '<document href="https://provider.example/private?password=secret">login</document>';
    const upstream = response(body, type);
    state.fetchSafe.mockResolvedValue(upstream);
    const result = await request(app).get(url);
    expect(result.status).toBe(502);
    expect(result.text || '').not.toMatch(/provider\.example|password|secret/);
    expect(upstream.body.destroyed).toBe(true);
  });

  it('serves self-contained TTML with protected headers', async () => {
    const ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Caption</p></div></body></tt>';
    state.fetchSafe.mockResolvedValue(response(ttml, 'application/ttml+xml'));
    const result = await request(app).get(url);
    expect(result.status).toBe(200);
    expect(result.text).toContain('Caption');
    expect(result.headers['content-security-policy']).toContain("default-src 'none'");
    expect(result.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects TTML with external playback dependencies', async () => {
    state.fetchSafe.mockResolvedValue(response('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body tts:backgroundImage="https://provider.example/pixel?password=secret"/></tt>', 'application/ttml+xml'));
    const result = await request(app).get(url);
    expect(result.status).toBe(502);
    expect(result.text || '').not.toMatch(/provider\.example|password|secret/);
  });

  it('preserves binary media and range responses', async () => {
    const status = url.startsWith('/movie/') || url.startsWith('/series/') ? 206 : 200;
    const upstream = response('media-bytes', 'video/mp4', status);
    upstream.headers.set('content-range', 'bytes 10-20/100');
    state.fetchSafe.mockResolvedValue(upstream);
    const result = await request(app).get(url).set('Range', 'bytes=10-20');
    expect(result.status).toBe(status);
    expect(result.body.toString()).toBe('media-bytes');
    if (url.startsWith('/movie/') || url.startsWith('/series/')) expect(result.headers['content-range']).toBe('bytes 10-20/100');
  });
});
