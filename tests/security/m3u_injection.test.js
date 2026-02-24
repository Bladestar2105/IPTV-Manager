import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define the mock implementation
const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      prepare: vi.fn(),
    },
  };
});

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
}));

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn(),
}));

vi.mock('../../src/services/epgService.js', () => ({
  getEpgPrograms: vi.fn(),
  getEpgXmlForChannels: vi.fn(),
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val), // Simple pass-through for test
  encrypt: vi.fn((val) => val),
}));

vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
}));

// Import the controller after mocking
import { playerPlaylist } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('Security: M3U Injection', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      query: {},
      params: {},
      hostname: 'localhost',
      secure: false,
    };
    res = {
      send: vi.fn(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
  });

  it('should sanitize newlines in channel name and group title to prevent M3U injection', async () => {
    const user = { id: 1, is_share_guest: false };
    getXtreamUser.mockResolvedValue(user);

    const maliciousChannel = {
      user_channel_id: 666,
      name: 'Safe Name\n#EXTINF:-1,Malicious Channel\nhttp://evil.com/stream.ts',
      logo: 'logo.png',
      epg_channel_id: 'bad1',
      manual_epg_id: null,
      stream_type: 'live',
      mime_type: 'ts',
      category_name: 'Safe Group\n#EXT-X-KEY:METHOD=AES-128,URI="http://evil.com/key"',
      metadata: '{}',
      plot: '',
      cast: '',
      director: '',
      genre: '',
      releaseDate: '',
      rating: '',
      episode_run_time: ''
    };

    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([maliciousChannel]) });

    await playerPlaylist(req, res);

    expect(res.send).toHaveBeenCalled();
    const output = res.send.mock.calls[0][0];

    // Check that injection attempts are thwarted
    // Newlines should be replaced by spaces or removed
    expect(output).not.toContain('\n#EXTINF:-1,Malicious Channel');
    expect(output).not.toContain('\nhttp://evil.com/stream.ts');
    expect(output).not.toContain('\n#EXT-X-KEY');

    // Also check that the original content is somewhat preserved but sanitized
    expect(output).toContain('Safe Name');
    expect(output).toContain('Malicious Channel'); // It will be there, but on the same line (hopefully)
  });
});
