import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import streamManager from '../../src/services/streamManager.js';
import db from '../../src/database/db.js';
import * as authService from '../../src/services/authService.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('node-fetch');
vi.mock('../../src/services/streamManager.js');
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
        if (query.includes('SELECT id FROM stream_stats')) {
           return { get: vi.fn().mockReturnValue({ id: 50 }), run: vi.fn() };
        }
        return { get: vi.fn(), run: vi.fn() };
      }),
    },
  };
});
vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val),
  encrypt: vi.fn((val) => val),
}));
vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost'),
  isSafeUrl: vi.fn(() => Promise.resolve(true)),
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
    expect(streamManager.remove).not.toHaveBeenCalled();

    // We can't check setTimeout calls easily in vitest unless we spy on global.setTimeout
    // But since cleanupUser was skipped, delay should also be skipped due to logic flow.

    vi.useRealTimers();
  });

  it('should CALL streamManager.add/cleanupUser for .m3u8 requests with transcode=true', async () => {
    req.query.transcode = 'true';
    vi.useFakeTimers();

    await streamController.proxyLive(req, res);
    await vi.runAllTimersAsync();

    expect(streamManager.cleanupUser).toHaveBeenCalled();
    expect(streamManager.add).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should CALL streamManager.add/cleanupUser for .ts requests', async () => {
    req.path = '/live/user/pass/1.ts';
    vi.useFakeTimers();

    await streamController.proxyLive(req, res);
    await vi.runAllTimersAsync();

    expect(streamManager.cleanupUser).toHaveBeenCalled();
    expect(streamManager.add).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
