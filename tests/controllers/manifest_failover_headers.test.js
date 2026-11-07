import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { upstreamRequestHeaders } from '../../src/utils/clientCookies.js';

const state = vi.hoisted(() => ({ fetchSafe: vi.fn(), createResource: vi.fn(), ffmpeg: vi.fn(), spawn: vi.fn(), channel: {}, episode: {}, headers: {}, meta: {} }));
vi.mock('fluent-ffmpeg', () => ({ default: state.ffmpeg }));
vi.mock('child_process', () => ({ spawn: state.spawn }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: async () => ({ id: 1 }) }));
vi.mock('../../src/services/streamManager.js', () => ({ default: { localStreams: new Map(), remove: vi.fn(), touch: vi.fn() } }));
vi.mock('../../src/services/clientResourceService.js', async original => ({ ...await original(), createClientResourceUrl: (...args) => state.createResource(...args) }));
vi.mock('../../src/utils/crypto.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../../src/utils/helpers.js', async original => ({ ...(await original()), isSafeUrl: async () => true }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: state.fetchSafe }));
vi.mock('../../src/controllers/streamControllerHelpers.js', async original => ({
  ...(await original()),
  getChannel: () => ({ ...state.channel }), getSeriesEpisode: () => ({ ...state.episode }),
  buildStreamHeaders: () => ({ headers: { ...state.headers }, meta: state.meta }),
  buildBackupUrls: () => ['https://backup.example/manifest.mpd'],
  reserveChannelSession: async () => true, reserveProviderSession: async () => ({ ...state.episode }),
  shareGuestAllowed: () => true, recordStreamStat: vi.fn(), createSafeCleanup: () => vi.fn(),
}));

const controllers = await import('../../src/controllers/streamController.js');
const { fetchWithBackups, probeTracksWithFfmpeg, sendSubtitleTrack } = await import('../../src/controllers/streamControllerHelpers.js');
const manifest = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation id="video"><SegmentTemplate initialization="init.mp4" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>';
const response = (url, status = 200) => ({ url, status, ok: status === 200,
  headers: new Headers({ 'content-type': 'application/dash+xml' }), body: Readable.from([manifest]),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.channel = { id: 1, user_channel_id: 1, provider_channel_id: 10, remote_stream_id: 99,
    name: 'Channel', stream_type: 'movie', provider_id: 3, provider_url: 'https://primary.example', provider_user: 'u', provider_pass: 'p', mime_type: 'mp4' };
  state.episode = { id: 3, user_channel_id: 1, remote_episode_id: 99, series_name: 'Series',
    url: 'https://primary.example', username: 'u', password: 'p', container_extension: 'mp4' };
  state.headers = { Authorization: 'Bearer configured-secret', 'X-Api-Key': 'configured-key', Cookie: 'session=one' };
  state.meta = {};
  state.createResource.mockReturnValue('https://manager.example/api/proxy/resource/test/resource');
});

it.each(['https://attacker.example/capture', '//attacker.example/capture', '../capture', '/capture', '%2e%2e/capture', '..%2fcapture', '..\\capture', 'other-channel.mpd', 'api/admin'])('rejects an escaping legacy MPD path %s before forwarding credentials', async mpdPath => {
  state.meta = { original_url: 'https://primary.example/private/path/manifest.mpd' };
  state.fetchSafe.mockResolvedValue(response('https://attacker.example/capture'));
  const req = { params: { stream_id: '1', mpdPath }, query: {}, headers: {}, on: vi.fn() };
  const res = { sendStatus: vi.fn(), setHeader: vi.fn(), send: vi.fn() };
  await controllers.proxyMpd(req, res);
  expect(res.sendStatus).toHaveBeenCalledWith(400);
  expect(state.fetchSafe).not.toHaveBeenCalled();
});

it('does not spawn subtitle extraction after disconnect during a 206 header wait', async () => {
  const req = { query: { subtitle_track: '2' } };
  const res = Object.assign(new EventEmitter(), { destroyed: false, setHeader: vi.fn(), end: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  state.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return child; });
  state.fetchSafe.mockImplementation(async () => {
    res.destroyed = true;
    res.emit('close');
    return { ...response('https://primary.example/movie.mp4'), status: 206, ok: true };
  });
  const outcome = await sendSubtitleTrack(res, 'https://primary.example/movie.mp4', [], {}, req).catch(error => error);
  expect(state.spawn).not.toHaveBeenCalled();
  expect(outcome).toHaveProperty('message', 'Media client disconnected');
});

it.each(['live', 'series'])('rejects a %s assignment at the movie playback route', async streamType => {
  state.channel.stream_type = streamType;
  const res = { sendStatus: vi.fn() };
  await controllers.proxyMovie({ params: { stream_id: '1' }, query: {} }, res);
  expect(res.sendStatus).toHaveBeenCalledWith(404);
  expect(state.fetchSafe).not.toHaveBeenCalled();
});

it('kills a track probe promptly when its reserved response closes', async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  state.spawn.mockReturnValue(child);
  const res = new EventEmitter();
  const pending = probeTracksWithFfmpeg('https://primary.example/movie.mp4', {}, res).catch(error => error);
  try {
    res.emit('close');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  } finally { child.emit('close', 0); }
  expect(await pending).toHaveProperty('message', 'Media client disconnected');
});

it.each(['tracks', 'subtitles', 'movie', 'series'])('reopens %s in FFmpeg with final-origin cookies and without provider credentials', async flow => {
  const finalUrl = 'https://cdn.example/final.mp4';
  const upstream = response(finalUrl);
  upstream.headers.set('set-cookie', 'cdn_session=acquired; Path=/; Secure');
  state.fetchSafe.mockResolvedValue(upstream);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  state.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return child; });
  const inputOptions = vi.fn().mockReturnThis();
  state.ffmpeg.mockReturnValue({ inputOptions, outputOptions: vi.fn().mockReturnThis(), on: vi.fn().mockReturnThis(), pipe: vi.fn() });
  const req = { params: { stream_id: '1', episode_id: '1' }, query: flow === 'tracks' ? { tracks: 'true' } : flow === 'subtitles' ? { subtitle_format: 'vtt', subtitle_track: '2' } : { transcode: 'true' }, headers: {}, on: vi.fn() };
  const res = { setHeader: vi.fn(), sendStatus: vi.fn(), json: vi.fn(), on: vi.fn(), end: vi.fn() };
  await controllers[flow === 'series' ? 'proxySeries' : 'proxyMovie'](req, res);
  expect(res.sendStatus).not.toHaveBeenCalled();
  let args;
  if (flow === 'tracks' || flow === 'subtitles') args = state.spawn.mock.calls[0][1];
  else {
    expect(state.ffmpeg).toHaveBeenCalledWith(finalUrl);
    args = inputOptions.mock.calls[0][0];
  }
  const headerString = args[args.indexOf('-headers') + 1];
  expect(headerString).toContain('Cookie: cdn_session=acquired');
  expect(headerString).not.toMatch(/configured-secret|configured-key|session=one/);
});

describe('manifest failover credential origin', () => {
  it('reports the selected backup separately from its final redirect URL', async () => {
    state.fetchSafe.mockResolvedValueOnce(response('https://primary.example/main.mpd', 503))
      .mockResolvedValueOnce(response('https://redirect.example/final.mpd'));
    expect(await fetchWithBackups('https://primary.example/main.mpd', ['https://backup.example/manifest.mpd'], { headers: state.headers }))
      .toMatchObject({ selectedUrl: 'https://backup.example/manifest.mpd', successfulUrl: 'https://redirect.example/final.mpd' });
  });

  it.each(['proxyLive', 'proxyMpd', 'proxyTimeshift', 'proxyMovie', 'proxySeries'].flatMap(method => [
    [method, 'https://backup.example/manifest.mpd'], [method, 'https://redirect.example/final.mpd'],
  ]))('%s binds descendants to the selected backup when the response URL is %s', async (method, finalUrl) => {
    state.fetchSafe.mockResolvedValueOnce(response('https://primary.example/main.mpd', 503))
      .mockResolvedValueOnce(response(finalUrl));
    const req = { params: { stream_id: '1', episode_id: '1', username: 'user', password: 'pass', duration: '60', start: '2026-10-18:10-00' },
      path: '/live/user/pass/1.m3u8', query: {}, headers: {}, on: vi.fn() };
    const res = { setHeader: vi.fn(), send: vi.fn(), sendStatus: vi.fn(), once: vi.fn() };
    await controllers[method](req, res);
    expect(res.sendStatus).not.toHaveBeenCalled();
    expect(state.fetchSafe).toHaveBeenCalledTimes(2);
    expect(state.createResource).toHaveBeenCalled();
    const [, , mappedUrl, context] = state.createResource.mock.calls[0];
    expect(new URL(mappedUrl).origin).toBe(new URL(finalUrl).origin);
    expect(context.headerOrigin).toBe('https://backup.example/manifest.mpd');
    const sameOrigin = new Headers(upstreamRequestHeaders(context, 'https://backup.example/segments/chunk.m4s'));
    // Series currently configures only a user agent, while the other flows carry provider headers.
    if (method !== 'proxySeries') {
      expect(sameOrigin.get('authorization')).toBe('Bearer configured-secret');
      expect(sameOrigin.get('x-api-key')).toBe('configured-key');
      expect(sameOrigin.get('cookie')).toBe('session=one');
    }
    const foreign = new Headers(upstreamRequestHeaders(context, 'https://redirect.example/segments/chunk.m4s'));
    expect(foreign.get('authorization')).toBeNull();
    expect(foreign.get('x-api-key')).toBeNull();
    expect(foreign.get('cookie')).toBeNull();
  });
});
