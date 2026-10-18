import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { upstreamRequestHeaders } from '../../src/utils/clientCookies.js';

const state = vi.hoisted(() => ({ fetchSafe: vi.fn(), createResource: vi.fn(), channel: {}, episode: {}, headers: {} }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) } }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: async () => ({ id: 1 }) }));
vi.mock('../../src/services/streamManager.js', () => ({ default: { localStreams: new Map(), remove: vi.fn(), touch: vi.fn() } }));
vi.mock('../../src/services/clientResourceService.js', () => ({ createClientResourceUrl: (...args) => state.createResource(...args) }));
vi.mock('../../src/utils/crypto.js', () => ({ decrypt: value => value, encrypt: value => value }));
vi.mock('../../src/utils/helpers.js', async original => ({ ...(await original()), isSafeUrl: async () => true }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: state.fetchSafe }));
vi.mock('../../src/controllers/streamControllerHelpers.js', async original => ({
  ...(await original()),
  getChannel: () => ({ ...state.channel }), getSeriesEpisode: () => ({ ...state.episode }),
  buildStreamHeaders: () => ({ headers: { ...state.headers }, meta: {} }),
  buildBackupUrls: () => ['https://backup.example/manifest.mpd'],
  reserveChannelSession: async () => true, reserveProviderSession: async () => ({ ...state.episode }),
  shareGuestAllowed: () => true, recordStreamStat: vi.fn(), createSafeCleanup: () => vi.fn(),
}));

const controllers = await import('../../src/controllers/streamController.js');
const { fetchWithBackups } = await import('../../src/controllers/streamControllerHelpers.js');
const manifest = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation id="video"><SegmentTemplate initialization="init.mp4" media="chunk-$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>';
const response = (url, status = 200) => ({ url, status, ok: status === 200,
  headers: new Headers({ 'content-type': 'application/dash+xml' }), body: Readable.from([manifest]),
});

beforeEach(() => {
  vi.clearAllMocks();
  state.channel = { id: 1, user_channel_id: 1, provider_channel_id: 10, remote_stream_id: 99,
    name: 'Channel', provider_id: 3, provider_url: 'https://primary.example', provider_user: 'u', provider_pass: 'p', mime_type: 'mp4' };
  state.episode = { id: 3, user_channel_id: 1, remote_episode_id: 99, series_name: 'Series',
    url: 'https://primary.example', username: 'u', password: 'p', container_extension: 'mp4' };
  state.headers = { Authorization: 'Bearer configured-secret', 'X-Api-Key': 'configured-key', Cookie: 'session=one' };
  state.createResource.mockReturnValue('https://manager.example/api/proxy/resource/test/resource');
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
