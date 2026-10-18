import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { preparePlaybackMedia } from '../../src/controllers/streamControllerHelpers.js';
import { playreadyMp4 } from '../fixtures/playreadyMp4.js';

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
  it.each(['moov', 'moof'])('starts an isolated protected playback for binary PlayReady %s metadata', async container => {
    const upstream = response(playreadyMp4(container), 'video/mp4');
    upstream.headers.set('set-cookie', 'session=initial; Path=/');
    state.fetchSafe.mockResolvedValue(upstream);
    const result = await request(app).get(url);
    expect(result.status).toBe(307);
    expect(result.headers.location).toBe('http://manager.example/r/abcdefghijklmnopqrstuv');
    expect(result.headers['cache-control']).toContain('no-store');
    expect(upstream.body.destroyed).toBe(true);
    expect(state.createClientResourceUrl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 1 }), expect.stringContaining('https://provider.example/'),
      expect.objectContaining({ kind: 'resource', channelId: 1, providerId: 3, channelName: expect.any(String) }));
  });
  it.each(['moov', 'unknown'])('recognizes mislabeled MP4 with a %s first box', async kind => {
    const prefix = Buffer.from([0, 0, 0, 8, 0x7a, 0x7a, 0x7a, 0x7a]);
    const bytes = kind === 'unknown' ? Buffer.concat([prefix, playreadyMp4()]) : playreadyMp4();
    const upstream = response(bytes, 'video/mp2t');
    state.fetchSafe.mockResolvedValue(upstream);
    expect((await request(app).get(url)).status).toBe(307);
    expect(upstream.body.destroyed).toBe(true);
  });

  it('keeps a transport stream with a printable ambiguous payload on its original connection', async () => {
    const packet = Buffer.alloc(188, 0xff);
    Buffer.from([0x47, 0x01, 0, 0x10, 0x41, 0x42, 0x43, 0x44]).copy(packet);
    const bytes = Buffer.concat([packet, packet, packet]);
    state.fetchSafe.mockResolvedValue(response(bytes, 'video/mp2t'));
    const result = await request(app).get(url);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(bytes);
  });

  it.each([Buffer.from([0x47, 0x40, 0, 0x10, 0, 0, 0, 0, 0xff]), Buffer.from([0x47, 0, 0])])('preserves transport bytes after inspecting their prefix', async bytes => {
    state.fetchSafe.mockResolvedValue(response(bytes, 'video/mp2t'));
    const result = await request(app).get(url);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(bytes);
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

  it('redirects initial range requests without caching request-specific range headers', async () => {
    const upstream = response(playreadyMp4(), 'video/mp4', 206);
    upstream.headers.set('content-range', 'bytes 10-20/100');
    state.fetchSafe.mockResolvedValue(upstream);
    const result = await request(app).get(url).set('Range', 'bytes=10-20');
    expect(result.status).toBe(307);
    expect(upstream.body.destroyed).toBe(true);
    const options = state.createClientResourceUrl.mock.calls[0][3];
    expect(new Headers(options.headers).has('range')).toBe(false);
  });
});

it.each(['abort', 'timeout', 'error'])('releases a stalled upstream during media classification on %s', async reason => {
  vi.useFakeTimers();
  const req = Object.assign(new EventEmitter(), { headers: {}, ip: '127.0.0.1' });
  const res = new EventEmitter();
  const body = new PassThrough();
  body.write(Buffer.from([0x47, 0x01, 0, 0x10, 0x41, 0x42, 0x43, 0x44]));
  const upstream = { status: 200, headers: new Headers({ 'content-type': 'video/mp2t' }), body };
  try {
    const pending = preparePlaybackMedia(req, res, { id: 1 }, upstream, { headers: {}, sourceUrl: 'https://provider.example/live.ts' });
    const rejected = expect(pending).rejects.toThrow(reason === 'abort' ? 'disconnected' : reason === 'timeout' ? 'timed out' : 'provider failed');
    if (reason === 'abort') req.emit('aborted');
    else if (reason === 'error') body.destroy(new Error('provider failed'));
    else await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(body.destroyed).toBe(true);
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  } finally { body.destroy(); vi.useRealTimers(); }
});

it('releases the initial provider reservation before publishing the playback redirect', async () => {
  const upstream = response(playreadyMp4(), 'video/mp4');
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { setHeader: vi.fn(), redirect: vi.fn() });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const pending = preparePlaybackMedia(req, res, { id: 1 }, upstream, { headers: {}, sourceUrl: 'https://provider.example/movie.mp4', releaseSession: () => released });
  expect(res.redirect).not.toHaveBeenCalled();
  expect(upstream.body.destroyed).toBe(true);
  release();
  await pending;
  expect(res.redirect).toHaveBeenCalledWith(307, expect.any(String));
});
