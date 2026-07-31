import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import * as streamController from '../../src/controllers/streamController.js';
import streamManager from '../../src/services/streamManager.js';
import db from '../../src/database/db.js';
import * as authService from '../../src/services/authService.js';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';

const { streamDbState } = vi.hoisted(() => ({
  streamDbState: { channelOverrides: {}, providerPool: [] }
}));

// Mock dependencies
vi.mock('node-fetch');
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));
vi.mock('../../src/services/streamManager.js', () => ({
  default: {
    add: vi.fn(),
    remove: vi.fn(),
    cleanupUser: vi.fn(),
    isSessionActive: vi.fn(),
    getUserConnectionCount: vi.fn(),
    getProviderConnectionCount: vi.fn(),
    localStreams: { set: vi.fn(), delete: vi.fn() }
  }
}));
vi.mock('../../src/services/authService.js');
vi.mock('../../src/database/db.js', () => {
  const seriesAssignment = (overrides = {}) => ({
    id: 1,
    user_id: 1,
    url: 'http://upstream.com',
    username: 'puser',
    password: 'ppass',
    max_connections: 10,
    backup_urls: null,
    user_agent: 'TestAgent',
    user_channel_id: 1,
    series_remote_id: 55,
    series_name: 'Test Series',
    ...overrides,
  });
  return {
    default: {
      prepare: vi.fn((query) => {
        if (query.includes('FROM series_episode_aliases a')) {
          return {
            get: vi.fn((aliasId, userId) => aliasId === 900000321 && userId === 1
              ? seriesAssignment({ episode_source_key: 'http://upstream.com', remote_episode_id: 1 })
              : undefined),
          };
        }
        if (query.includes('(uc.id = ? OR p.id = ?)')) {
          return {
            all: vi.fn((assignmentId, _providerId, userId) => {
              if (userId !== 1) return [];
              if (assignmentId === 1) return [seriesAssignment()];
              if (assignmentId === 7) {
                return [
                  seriesAssignment(),
                  seriesAssignment({ id: 2, user_channel_id: 2, series_remote_id: 56 }),
                ];
              }
              return [];
            }),
          };
        }
        if (query.includes('FROM provider_series_episodes')) {
          return {
            get: vi.fn((sourceKey, seriesRemoteId, remoteEpisodeId) =>
              sourceKey === 'http://upstream.com' && [55, 56].includes(seriesRemoteId) && remoteEpisodeId === 1
                ? { season: 1, episode_num: 1, title: 'Pilot', container_extension: '.MKV', logo: '' }
                : undefined),
          };
        }
        if (query.includes('FROM authorized_user_channels')) {
          return {
            get: vi.fn((streamId) => ({
              user_channel_id: 1,
              provider_channel_id: 100,
              remote_stream_id: `remote${streamId}`,
              name: 'Test Channel',
              metadata: '{}',
              mime_type: 'mkv',
              provider_url: 'http://upstream.com',
              provider_user: 'puser',
              provider_pass: 'ppass',
              backup_urls: null,
              user_agent: 'TestAgent',
              provider_id: 100,
              provider_max_connections: 10,
              granted_by_admin: 0,
              category_owner_id: 1,
              provider_owner_id: 1,
              ...(streamDbState.channelOverrides[streamId] || {}),
            })),
          };
        }
        if (query.includes('FROM providers WHERE user_id = ? AND url LIKE ?')) {
            return {
                all: vi.fn(() => streamDbState.providerPool)
            };
        }
        if (query.includes('SELECT id FROM stream_stats')) {
           return { get: vi.fn().mockReturnValue({ id: 50 }), run: vi.fn() };
        }
        return { get: vi.fn(), run: vi.fn(), all: vi.fn().mockReturnValue([]) };
      }),
    },
    getDb: vi.fn(() => ({
      prepare: vi.fn(() => ({
          get: vi.fn(),
          all: vi.fn().mockReturnValue([]),
          run: vi.fn()
      }))
    }))
  };
});
vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val),
  encrypt: vi.fn((val) => val),
}));
vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost'),
  isSafeUrl: vi.fn(() => Promise.resolve(true)),
  safeLookup: vi.fn((hostname, options, cb) => cb(null, '127.0.0.1', 4)),
  redactUrl: vi.fn((url) => url),
  providerSourceKey: vi.fn((url) => String(url || '').replace(/\/+$/, '')),
}));

// We don't mock ffmpeg here because it's not strictly needed for m3u8 logic test,
// but for transcode test it might fail if ffmpeg-static is missing.
// Ideally we should mock fluent-ffmpeg too.
vi.mock('fluent-ffmpeg', () => {
    return {
        default: vi.fn(() => ({
            inputFormat: vi.fn().mockReturnThis(),
            outputOptions: vi.fn().mockReturnThis(),
            on: vi.fn().mockReturnThis(),
            pipe: vi.fn().mockReturnThis(),
            kill: vi.fn(),
        }))
    };
});

function mockFfmpegProbe(stderrText) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  spawn.mockReturnValueOnce(child);
  process.nextTick(() => {
    child.stderr.emit('data', Buffer.from(stderrText));
    child.emit('close', 0);
  });
}

describe('Stream Controller Performance (proxyLive)', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();
    streamDbState.channelOverrides = {};
    streamDbState.providerPool = [{
      id: 100,
      user_id: 1,
      url: 'http://upstream.com',
      username: 'puser',
      password: 'ppass',
      backup_urls: null,
      user_agent: 'TestAgent',
      max_connections: 10,
    }];
    streamManager.isSessionActive.mockResolvedValue(false);
    streamManager.getProviderConnectionCount.mockResolvedValue(0);

    req = {
      params: { stream_id: '1', username: 'user', password: 'pass' },
      query: {},
      path: '/live/user/pass/1.m3u8',
      headers: {},
      ip: '127.0.0.1',
      on: vi.fn(),
    };

    res = {
      sendStatus: vi.fn(),
      setHeader: vi.fn(),
      send: vi.fn(),
      json: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn(),
    };

    // Mock auth
    authService.getXtreamUser.mockResolvedValue({ id: 1, username: 'testuser', allowed_channels: [1] });

    // Mock fetch response
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: vi.fn() },
      text: vi.fn().mockResolvedValue('#EXTM3U\n#EXTINF:-1,Stream\nhttp://segment.ts'),
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sourceProvider = (overrides = {}) => ({
    provider_id: 200,
    provider_url: 'http://upstream.com',
    provider_user: 'source-user',
    provider_pass: 'source-pass',
    backup_urls: null,
    user_agent: 'SourceAgent',
    provider_max_connections: 2,
    granted_by_admin: 0,
    category_owner_id: 1,
    provider_owner_id: 1,
    ...overrides,
  });

  it('keeps same-owner provider pooling behavior', async () => {
    streamDbState.providerPool = [
      { id: 101, url: 'http://upstream.com/', username: 'pool-user', password: 'pool-pass', max_connections: 3 },
      { id: 200, url: 'http://upstream.com', username: 'source-user', password: 'source-pass', max_connections: 2 },
    ];

    const selected = await streamController.findAvailableProvider(1, sourceProvider(), req.ip, 'Live');

    expect(selected.id).toBe(101);
  });

  it('uses an explicitly granted cross-owner source before an unrelated same-panel account', async () => {
    streamDbState.providerPool = [
      { id: 101, url: 'http://upstream.com', username: 'target-user', password: 'target-pass', max_connections: 3 },
    ];
    const source = sourceProvider({
      granted_by_admin: 1,
      category_owner_id: 1,
      provider_owner_id: 2,
      backup_urls: JSON.stringify(['http://configured-backup.example']),
    });

    const selected = await streamController.findAvailableProvider(1, source, req.ip, 'Live');

    expect(selected.id).toBe(200);
    expect(selected.backup_urls).toBe(source.backup_urls);
  });

  it('applies the cross-owner source connection limit without substituting a same-panel account', async () => {
    streamDbState.providerPool = [
      { id: 101, url: 'http://upstream.com', username: 'target-user', password: 'target-pass', max_connections: 3 },
    ];
    streamManager.getProviderConnectionCount.mockImplementation(async id => id === 200 ? 1 : 0);

    const selected = await streamController.findAvailableProvider(1, sourceProvider({
      granted_by_admin: 1,
      category_owner_id: 1,
      provider_owner_id: 2,
      provider_max_connections: 1,
    }), req.ip, 'Live');

    expect(selected).toBeNull();
    expect(streamManager.getProviderConnectionCount).toHaveBeenCalledWith(200);
    expect(streamManager.getProviderConnectionCount).not.toHaveBeenCalledWith(101);
  });

  it('uses another account only when its URL is an explicit source backup', async () => {
    streamDbState.providerPool = [
      { id: 101, url: 'http://upstream.com', username: 'unrelated', password: 'unrelated', max_connections: 3 },
      { id: 300, url: 'http://failover.example/', username: 'failover', password: 'failover-pass', max_connections: 2 },
    ];
    streamManager.getProviderConnectionCount.mockImplementation(async id => id === 200 ? 1 : 0);

    const selected = await streamController.findAvailableProvider(1, sourceProvider({
      granted_by_admin: 1,
      category_owner_id: 1,
      provider_owner_id: 2,
      provider_max_connections: 1,
      backup_urls: JSON.stringify(['http://failover.example']),
    }), req.ip, 'Live');

    expect(selected.id).toBe(300);
    expect(streamManager.getProviderConnectionCount).not.toHaveBeenCalledWith(101);
  });

  it('should NOT call streamManager.add/cleanupUser/remove for standard .m3u8 requests', async () => {
    vi.useFakeTimers(); // Intercept setTimeout

    await streamController.proxyLive(req, res);

    // Fast-forward timers just in case (though we expect NO delay)
    await vi.runAllTimersAsync();

    expect(streamManager.cleanupUser).not.toHaveBeenCalled();
    expect(streamManager.add).not.toHaveBeenCalled();

    // We DO call remove for .m3u8 explicitly just before early return to ensure cleanup
    // We can check if remove was called, or just ignore it if it doesn't hurt.
    expect(streamManager.remove).toHaveBeenCalled();
    // The main assertion is that add/cleanupUser are not called to save overhead.

    vi.useRealTimers();
  });

  it('should CALL streamManager.add/cleanupUser for .m3u8 requests with transcode=true', async () => {
    req.query.transcode = 'true';
    vi.useFakeTimers();

    const promise = streamController.proxyLive(req, res);
    await vi.runAllTimersAsync();
    await promise;

    expect(streamManager.cleanupUser).toHaveBeenCalled();
    expect(streamManager.add).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should CALL streamManager.add/cleanupUser for .ts requests', async () => {
    req.path = '/live/user/pass/1.ts';
    vi.useFakeTimers();

    const promise = streamController.proxyLive(req, res);
    await vi.runAllTimersAsync();
    await promise;

    expect(streamManager.cleanupUser).toHaveBeenCalled();
    expect(streamManager.add).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('uses the stored MKV extension when the public movie suffix differs', async () => {
    req.params.ext = 'ts';
    req.path = '/movie/user/pass/1.ts';
    req.headers = {
      range: 'bytes=100-200',
      'user-agent': 'Mozilla/5.0 Firefox/140',
    };
    res.headersSent = false;

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 206,
      url: 'http://upstream.com/movie/puser/ppass/remote1.mkv',
      headers: {
        get: vi.fn((name) => {
          const values = {
            'content-type': 'video/x-matroska',
            'content-length': '101',
            'content-range': 'bytes 100-200/1000',
            'accept-ranges': 'bytes',
          };
          return values[String(name).toLowerCase()] || null;
        }),
      },
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() },
    });

    await streamController.proxyMovie(req, res);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/movie/puser/ppass/remote1.mkv'),
      expect.objectContaining({
        headers: expect.objectContaining({ Range: 'bytes=100-200' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 100-200/1000');
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
  });

  it('falls back to MP4 when stored movie metadata has no extension', async () => {
    streamDbState.channelOverrides[2] = { mime_type: '' };
    req.params = { ...req.params, stream_id: '2', ext: 'ts' };
    req.path = '/movie/user/pass/2.ts';
    res.headersSent = false;

    await streamController.proxyMovie(req, res);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/movie/puser/ppass/remote2.mp4'),
      expect.any(Object)
    );
  });

  it('ignores a malformed public movie extension', async () => {
    req.params.ext = 'ts%0a%23EXTINF';
    req.path = '/movie/user/pass/1.ts%0a%23EXTINF';
    res.headersSent = false;

    await streamController.proxyMovie(req, res);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/movie/puser/ppass/remote1.mkv'),
      expect.any(Object)
    );
    expect(fetch.mock.calls[0][0]).not.toContain('EXTINF');
  });

  it('uses the stored extension for movie backup URLs', async () => {
    const backupUrls = JSON.stringify(['http://backup.example']);
    streamDbState.channelOverrides[3] = {
      mime_type: 'mkv',
      backup_urls: backupUrls
    };
    streamDbState.providerPool[0].backup_urls = backupUrls;
    req.params = { ...req.params, stream_id: '3', ext: 'ts' };
    req.path = '/movie/user/pass/3.ts';
    res.headersSent = false;
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: vi.fn() },
      body: { destroy: vi.fn() },
    }).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: vi.fn() },
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() },
    });

    await streamController.proxyMovie(req, res);

    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'http://upstream.com/movie/puser/ppass/remote3.mkv',
      'http://backup.example/movie/puser/ppass/remote3.mkv'
    ]);
  });

  it('proxies a cross-owner movie through the exact granted source account', async () => {
    streamDbState.channelOverrides[4] = {
      mime_type: 'mp4',
      provider_id: 200,
      provider_url: 'http://source.example',
      provider_user: 'source-user',
      provider_pass: 'source-pass',
      provider_max_connections: 2,
      backup_urls: JSON.stringify(['http://source-backup.example']),
      granted_by_admin: 1,
      category_owner_id: 1,
      provider_owner_id: 2,
    };
    streamDbState.providerPool = [{
      id: 101,
      url: 'http://source.example',
      username: 'target-user',
      password: 'target-pass',
      max_connections: 5,
    }];
    req.params = { ...req.params, stream_id: '4', ext: 'ts' };
    res.headersSent = false;

    await streamController.proxyMovie(req, res);

    expect(fetch).toHaveBeenCalledWith(
      'http://source.example/movie/source-user/source-pass/remote4.mp4',
      expect.any(Object)
    );
  });

  it('proxies through an explicitly compatible cross-owner account failover', async () => {
    streamDbState.channelOverrides[5] = {
      mime_type: 'mp4',
      provider_id: 200,
      provider_url: 'http://source.example',
      provider_user: 'source-user',
      provider_pass: 'source-pass',
      provider_max_connections: 1,
      backup_urls: JSON.stringify(['http://failover.example']),
      granted_by_admin: 1,
      category_owner_id: 1,
      provider_owner_id: 2,
    };
    streamDbState.providerPool = [
      { id: 101, url: 'http://source.example', username: 'unrelated', password: 'unrelated', max_connections: 5 },
      { id: 300, url: 'http://failover.example', username: 'failover-user', password: 'failover-pass', max_connections: 2, backup_urls: null },
    ];
    streamManager.getProviderConnectionCount.mockImplementation(async id => id === 200 ? 1 : 0);
    req.params = { ...req.params, stream_id: '5', ext: 'ts' };
    res.headersSent = false;

    await streamController.proxyMovie(req, res);

    expect(fetch).toHaveBeenCalledWith(
      'http://failover.example/movie/failover-user/failover-pass/remote5.mp4',
      expect.any(Object)
    );
  });

  it('uses the stored extension for movie transcoding', async () => {
    req.params.ext = 'ts';
    req.query.transcode = 'true';
    req.path = '/movie/user/pass/1.ts';
    res.headersSent = false;

    await streamController.proxyMovie(req, res);

    expect(ffmpeg).toHaveBeenCalledWith('http://upstream.com/movie/puser/ppass/remote1.mkv');
  });

  it('uses the stored MKV extension when the public series suffix differs', async () => {
    req.params = { episode_id: '900000321', ext: 'mp4' };
    req.path = '/series/user/pass/900000321.mp4';
    req.headers = {
      range: 'bytes=300-400',
      'user-agent': 'Mozilla/5.0 Firefox/140',
    };
    res.headersSent = false;

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 206,
      url: 'http://upstream.com/series/puser/ppass/1.mkv',
      headers: {
        get: vi.fn((name) => {
          const values = {
            'content-type': 'video/x-matroska',
            'content-length': '101',
            'content-range': 'bytes 300-400/1000',
            'accept-ranges': 'bytes',
          };
          return values[String(name).toLowerCase()] || null;
        }),
      },
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() },
    });

    await streamController.proxySeries(req, res);

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM series_episode_aliases a'));
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM provider_series_episodes'));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/series/puser/ppass/1.mkv'),
      expect.objectContaining({
        headers: expect.objectContaining({ Range: 'bytes=300-400' }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(206);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Range', 'bytes 300-400/1000');
    expect(res.setHeader).toHaveBeenCalledWith('Accept-Ranges', 'bytes');
  });

  it('resolves a stale provider-based episode ID only when it has one exact match', async () => {
    req.params = { episode_id: '1000000001', ext: 'mp4' };
    req.headers = { range: 'bytes=0-10' };
    res.headersSent = false;

    await streamController.proxySeries(req, res);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/series/puser/ppass/1.mkv'),
      expect.any(Object)
    );
  });

  it('fails closed when a stale provider-based episode ID matches multiple series', async () => {
    req.params = { episode_id: '7000000001', ext: 'mkv' };

    await streamController.proxySeries(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['track probing', { tracks: 'true' }],
    ['subtitle extraction', { subtitle_format: 'vtt', subtitle_track: '1' }],
    ['transcoding', { transcode: 'true' }],
  ])('rejects an unknown series episode before %s', async (_label, query) => {
    req.params = { episode_id: '1000000002', ext: 'mkv' };
    req.query = query;

    await streamController.proxySeries(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(streamManager.add).not.toHaveBeenCalled();
  });

  it('rejects an episode identifier for another user assignment', async () => {
    req.params = { episode_id: '2000000001', ext: 'mkv' };

    await streamController.proxySeries(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows a share guest only for the explicitly shared series', async () => {
    req.params = { episode_id: '900000321', ext: 'mkv' };
    req.headers = { range: 'bytes=0-10' };
    res.headersSent = false;
    authService.getXtreamUser.mockResolvedValue({
      id: 1,
      is_share_guest: true,
      allowed_channels: [1],
      share_start: 0,
      share_end: 0,
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 206,
      headers: { get: vi.fn() },
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() },
    });

    await streamController.proxySeries(req, res);

    expect(fetch).toHaveBeenCalled();

    vi.clearAllMocks();
    authService.getXtreamUser.mockResolvedValue({
      id: 1,
      is_share_guest: true,
      allowed_channels: [2],
      share_start: 0,
      share_end: 0,
    });
    await streamController.proxySeries(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return probed VOD tracks without opening a stream session', async () => {
    req.params.ext = 'mkv';
    req.query.tracks = 'true';
    req.path = '/movie/user/pass/1.mkv';

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'http://upstream.com/movie/puser/ppass/remote1.mkv',
      headers: { get: vi.fn() },
      body: { destroy: vi.fn(), pipe: vi.fn(), on: vi.fn() },
    });
    mockFfmpegProbe(`
Input #0, matroska,webm, from 'movie.mkv':
  Stream #0:0: Video: h264
  Stream #0:1(deu): Audio: ac3, 48000 Hz, 5.1
  Stream #0:2(eng): Audio: aac, 48000 Hz, stereo
  Stream #0:3(deu): Subtitle: subrip
`);

    await streamController.proxyMovie(req, res);

    expect(streamManager.add).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toContain('http://upstream.com/movie/puser/ppass/remote1.mkv');
    expect(res.json).toHaveBeenCalledWith({
      audio: [
        { index: 1, language: 'deu', codec: 'ac3', label: 'deu - ac3' },
        { index: 2, language: 'eng', codec: 'aac', label: 'eng - aac' },
      ],
      subtitles: [
        { index: 3, language: 'deu', codec: 'subrip', label: 'deu - subrip' },
      ],
    });
  });

  it('should return selected VOD subtitles as WebVTT without opening a stream session', async () => {
    req.params.ext = 'mkv';
    req.query.subtitle_track = '3';
    req.query.subtitle_format = 'vtt';
    req.path = '/movie/user/pass/1.mkv';

    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'http://upstream.com/movie/puser/ppass/remote1.mkv',
      headers: { get: vi.fn() },
      body: { destroy: vi.fn(), pipe: vi.fn(), on: vi.fn() },
    });

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawn.mockImplementationOnce(() => {
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n'));
        child.emit('close', 0);
      });
      return child;
    });

    await streamController.proxyMovie(req, res);

    expect(streamManager.add).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/vtt; charset=utf-8');
    expect(spawn.mock.calls[0][1]).toContain('http://upstream.com/movie/puser/ppass/remote1.mkv');
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-map', '0:3', '-f', 'webvtt', '-']),
      expect.any(Object)
    );
    expect(res.write).toHaveBeenCalledWith(Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n'));
    expect(res.end).toHaveBeenCalled();
  });

  it('should map selected VOD audio and subtitle tracks through ffmpeg', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/controllers/streamController.js'), 'utf8');

    expect(source).toContain('function buildVodOutputOptions(req)');
    expect(source).toContain('req.query.audio_track');
    expect(source).toContain('req.query.subtitle_track');
    expect(source).toContain("options.push('-map 0:' + audioTrack)");
    expect(source).toContain("options.push('-map 0:' + subtitleTrack)");
    expect(source).toContain("options.push('-c:s mov_text')");
  });
});
