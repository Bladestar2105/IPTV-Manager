import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
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

describe('xtreamController - playerPlaylist', () => {
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

  it('should generate M3U with metadata even with numeric values and newlines', async () => {
    const user = { id: 1, is_share_guest: false };
    getXtreamUser.mockResolvedValue(user);

    const movieChannel = {
      user_channel_id: 100,
      name: 'Movie A',
      logo: 'logo.png',
      epg_channel_id: 'mv1',
      manual_epg_id: null,
      stream_type: 'movie',
      mime_type: 'mp4',
      category_name: 'Action',
      metadata: '{}',
      plot: 'Line 1\nLine 2', // Newline
      cast: 'Actor A',
      director: 'Director B',
      genre: 'Action',
      releaseDate: '2023',
      rating: 8.5, // Numeric
      episode_run_time: 120 // Numeric
    };

    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([movieChannel]) });

    await playerPlaylist(req, res);

    expect(res.send).toHaveBeenCalled();
    const output = res.send.mock.calls[0][0];

    // Check for attributes
    expect(output).toContain('plot="Line 1 Line 2"'); // Newline replaced
    expect(output).toContain('rating="8.5"'); // Numeric cast to string
    expect(output).toContain('duration="120"'); // Numeric cast to string
    expect(output).toContain('cast="Actor A"');
  });
});
