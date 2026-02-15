import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as streamController from '../src/controllers/streamController.js';
import streamManager from '../src/stream_manager.js';
import { getXtreamUser } from '../src/services/authService.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('../src/database/db.js', () => ({
  default: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      run: vi.fn()
    })
  }
}));

vi.mock('../src/services/authService.js', () => ({
  getXtreamUser: vi.fn()
}));

vi.mock('../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn().mockResolvedValue(true),
  getBaseUrl: vi.fn().mockReturnValue('http://localhost')
}));

vi.mock('../src/utils/crypto.js', () => ({
  decrypt: vi.fn().mockReturnValue('decrypted'),
  encrypt: vi.fn().mockReturnValue('encrypted')
}));

vi.mock('node-fetch');

// We need to spy on streamManager methods, but we imported the real instance.
// We can spy on it directly.

describe('Stream Controller - 502 EOF Reproduction', () => {
  let req, res;

  beforeEach(() => {
    req = {
      params: { stream_id: '428', username: 'u', password: 'p' },
      query: {},
      path: '/live/u/p/428.ts',
      ip: '127.0.0.1',
      headers: {},
      on: vi.fn()
    };
    res = {
      sendStatus: vi.fn(),
      setHeader: vi.fn(),
      headersSent: false,
      destroy: vi.fn(),
      destroyed: false
    };
    vi.clearAllMocks();

    // Clear stream manager local streams
    streamManager.localStreams.clear();
  });

  it('should destroy response when upstream returns 502, causing EOF', async () => {
    // Setup valid user
    getXtreamUser.mockResolvedValue({ id: 1, username: 'test' });

    // Setup channel found
    const db = (await import('../src/database/db.js')).default;
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        user_channel_id: 1,
        name: 'Test Channel',
        provider_url: 'http://provider.com',
        provider_user: 'u',
        provider_pass: 'p',
        remote_stream_id: '123'
      }),
      run: vi.fn()
    });

    // Mock fetch to return 502 or fail
    fetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: { get: () => null },
      body: { destroy: vi.fn() }
    });

    // Spy on streamManager.remove
    const removeSpy = vi.spyOn(streamManager, 'remove');

    // Spy on res.destroy
    // res.destroy is already a mock

    await streamController.proxyLive(req, res);

    expect(fetch).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();

    // Crucial check: verify that res.destroy was called
    // In the current buggy implementation, streamManager.remove triggers resource.destroy which triggers res.destroy
    // Note: streamManager.add registers res initially, then proxyLive updates it to an object { destroy: ... }
    // but ONLY if upstream fetch succeeds and we proceed to pipe.

    // Wait, in the failing fetch case:
    // const upstream = await fetch(...)
    // if (!upstream.ok) { ... streamManager.remove(...) ... }

    // At this point, what is in streamManager?
    // await streamManager.add(..., res) was called BEFORE fetch.
    // So the resource IS `res`.

    // So streamManager.remove(id) calls res.destroy().
    // Expect res.destroy NOT to be called, because we manually removed it from localStreams
    // before calling streamManager.remove.
    expect(res.destroy).not.toHaveBeenCalled();

    // And verify sendStatus was called
    expect(res.sendStatus).toHaveBeenCalledWith(502);

    // If res.destroy() is called, writing to it (sendStatus) typically fails or is ignored by the client (EOF).
  });
});
