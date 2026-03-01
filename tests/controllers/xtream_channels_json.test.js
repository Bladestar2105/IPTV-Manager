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
import { playerChannelsJson } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('xtreamController - playerChannelsJson', () => {
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
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
  });

  it('should generate JSON with metadata', async () => {
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

    await playerChannelsJson(req, res);

    expect(res.json).toHaveBeenCalled();
    const output = res.json.mock.calls[0][0];

    expect(output.length).toBe(1);
    expect(output[0].plot).toBe('Line 1\nLine 2'); // No newline replacement for JSON
    expect(output[0].rating).toBe(8.5); // Number ok
    expect(output[0].duration).toBe(120); // Number ok
    expect(output[0].cast).toBe('Actor A');
    expect(output[0].type).toBe('movie');
    expect(output[0].url).toContain('/movie/token/auth/100.mp4');
  });
});
