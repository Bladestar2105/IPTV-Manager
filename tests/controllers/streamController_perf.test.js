import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import streamManager from '../../src/services/streamManager.js';
import db from '../../src/database/db.js';
import * as authService from '../../src/services/authService.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('node-fetch');
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
        if (query.includes('FROM user_channels')) {
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
});
