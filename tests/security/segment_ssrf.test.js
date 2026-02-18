import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as streamController from '../../src/controllers/streamController.js';
import * as helpers from '../../src/utils/helpers.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn().mockResolvedValue({ id: 1, username: 'testuser' })
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((text) => {
      if (text === 'encrypted_base_unsafe') return JSON.stringify({ s: false });
      if (text === 'encrypted_data') return JSON.stringify({ u: 'http://unsafe.local/segment.ts' });
      if (text === 'encrypted_base_safe') return JSON.stringify({ s: true });
      if (text === 'encrypted_data_safe') return JSON.stringify({ u: 'http://safe.remote/segment.ts' });
      return null;
  }),
  encrypt: vi.fn((text) => 'encrypted')
}));

vi.mock('../../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn().mockResolvedValue(false),
  getBaseUrl: () => 'http://localhost:3000',
  getSetting: () => null,
  safeLookup: vi.fn()
}));

vi.mock('node-fetch', () => ({
  default: vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'video/mp2t' },
      body: { pipe: vi.fn(), on: vi.fn(), destroy: vi.fn() }
  })
}));

vi.mock('../../src/database/db.js', () => ({
  default: { prepare: () => ({ get: () => ({}), run: () => ({}) }) }
}));

vi.mock('../../src/services/streamManager.js', () => ({
  default: { add: vi.fn(), remove: vi.fn(), cleanupUser: vi.fn(), localStreams: new Map() }
}));

vi.mock('fluent-ffmpeg', () => {
  return {
    default: () => ({
      inputFormat: () => ({ outputOptions: () => ({ on: () => ({ on: () => ({ pipe: () => {} }) }) }) }),
      outputOptions: () => ({ on: () => ({ on: () => ({ pipe: () => {} }) }) })
    })
  };
});

describe('proxySegment SSRF Protection', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();

    req = {
      query: {},
      ip: '127.0.0.1',
      headers: {},
      user: { id: 1, username: 'testuser' }
    };

    res = {
      sendStatus: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn()
    };
  });

  it('should BLOCK unsafe URL even if s=false is provided in encrypted base/data', async () => {
    req.query.base = 'encrypted_base_unsafe';
    req.query.data = 'encrypted_data';

    // Mock isSafeUrl to return false
    helpers.isSafeUrl.mockResolvedValue(false);

    await streamController.proxySegment(req, res);

    expect(helpers.isSafeUrl).toHaveBeenCalledWith('http://unsafe.local/segment.ts');
    expect(fetch).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(403);
  });

  it('should call fetch with agent for SAFE URL', async () => {
    req.query.base = 'encrypted_base_safe';
    req.query.data = 'encrypted_data_safe';

    // Mock isSafeUrl to true
    helpers.isSafeUrl.mockResolvedValue(true);

    await streamController.proxySegment(req, res);

    expect(helpers.isSafeUrl).toHaveBeenCalledWith('http://safe.remote/segment.ts');
    expect(fetch).toHaveBeenCalled();

    const calls = fetch.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('http://safe.remote/segment.ts');

    const options = calls[0][1];
    expect(options).toBeDefined();
    expect(options.agent).toBeDefined();
    expect(typeof options.agent).toBe('function');
  });
});
