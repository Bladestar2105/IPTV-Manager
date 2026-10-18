import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'node:stream';
import { playreadyMp4, providerLicense } from '../fixtures/playreadyMp4.js';

const state = vi.hoisted(() => ({ fetchSafe: vi.fn(), createClientResourceUrl: vi.fn() }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: async () => ({ id: 1 }) }));
vi.mock('../../src/services/streamManager.js', () => ({ default: { localStreams: new Map(), remove: vi.fn(), touch: vi.fn(), cleanupSession: vi.fn() } }));
vi.mock('../../src/services/clientResourceService.js', async original => ({ ...await original(), createClientResourceUrl: state.createClientResourceUrl }));
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
beforeEach(() => { state.fetchSafe.mockReset(); state.createClientResourceUrl.mockReset().mockReturnValue('http://manager.example/r/abcdefghijklmnopqrstuv'); });

describe.each(paths)('initial stream privacy for %s', url => {
  it.each(['moov', 'moof'])('rewrites binary PlayReady %s metadata without moving media', async container => {
    const original = playreadyMp4(container);
    state.fetchSafe.mockResolvedValue(response(original, 'video/mp4'));
    const result = await request(app).get(url);
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(original.length);
    expect(result.body.includes(Buffer.from(providerLicense, 'utf16le'))).toBe(false);
    expect(result.body.includes(Buffer.from('http://manager.example/r/abcdefghijklmnopqrstuv', 'utf16le'))).toBe(true);
    expect(result.body.indexOf(Buffer.from('sample-bytes'))).toBe(original.indexOf(Buffer.from('sample-bytes')));
    expect(state.createClientResourceUrl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 1 }), providerLicense,
      expect.objectContaining({ kind: 'license', compact: true, compactIdentity: expect.any(String), channelId: 1, providerId: 3 }));
  });
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
    state.fetchSafe.mockImplementation((_target, options) => {
      const ranged = status === 206 && new Headers(options.headers).has('range');
      const body = status === 200 || ranged ? Buffer.from('media-bytes') : Buffer.concat([Buffer.alloc(10), Buffer.from('media-bytes'), Buffer.alloc(79)]);
      const upstream = response(body, 'video/mp4', ranged ? 206 : 200);
      upstream.headers.set('content-length', String(body.length));
      if (ranged) upstream.headers.set('content-range', 'bytes 10-20/100');
      return upstream;
    });
    const result = await request(app).get(url).set('Range', 'bytes=10-20');
    expect(result.status).toBe(status);
    expect(result.body.toString()).toBe('media-bytes');
    if (url.startsWith('/movie/') || url.startsWith('/series/')) expect(result.headers['content-range']).toBe('bytes 10-20/100');
  });
});
