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
  return {
    default: {
      prepare: vi.fn((query) => {
        if (query.includes("WHERE uc.id = ? AND cat.user_id = ? AND pc.stream_type = 'series'")) {
          return {
            get: vi.fn((assignmentId, userId) => assignmentId === 1 && userId === 1 ? {
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
            } : undefined),
          };
        }
        if (query.includes('FROM provider_series_episodes')) {
          return {
            get: vi.fn((sourceKey, seriesRemoteId, remoteEpisodeId) =>
              sourceKey === 'http://upstream.com' && seriesRemoteId === 55 && remoteEpisodeId === 1
                ? { season: 1, episode_num: 1, title: 'Pilot', container_extension: 'mkv', logo: '' }
                : undefined),
          };
        }
        if (query.includes('FROM authorized_user_channels')) {
          return {
            get: vi.fn().mockReturnValue({
              user_channel_id: 1,
              provider_channel_id: 100,
              remote_stream_id: 'remote1',
              name: 'Test Channel',
              metadata: '{}',
              provider_url: 'http://upstream.com',
              provider_user: 'puser',
              provider_pass: 'ppass',
              backup_urls: null,
              user_agent: 'TestAgent',
            }),
          };
        }
        if (query.includes('FROM providers WHERE user_id = ? AND url LIKE ?')) {
            return {
                all: vi.fn().mockReturnValue([{
                    id: 100,
                    user_id: 1,
                    url: 'http://upstream.com',
                    username: 'puser',
                    password: 'ppass',
                    max_connections: 10
                }])
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
  providerSourceKey: vi.fn((url) => String(url || '')),
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

  it('should proxy MKV VOD range requests without browser auto-transcode', async () => {
    req.params.ext = 'mkv';
    req.path = '/movie/user/pass/1.mkv';
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

  it('should proxy MKV series range requests without browser auto-transcode', async () => {
    req.params = { episode_id: '1000000001', ext: 'mkv' };
    req.path = '/series/user/pass/1000000001.mkv';
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

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("pc.stream_type = 'series'"));
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
    req.params = { episode_id: '1000000001', ext: 'mkv' };
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
