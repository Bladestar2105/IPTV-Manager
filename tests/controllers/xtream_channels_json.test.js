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
  openDbConnection: vi.fn(() => ({ prepare: mockDb.prepare, close: vi.fn() })),
}));

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn(),
}));

vi.mock('../../src/services/cacheService.js', () => ({
  channelsJsonCache: new Map(),
}));

vi.mock('../../src/services/epgService.js', () => ({
  getEpgPrograms: vi.fn(),
  getEpgProgramsForChannels: vi.fn(),
  getEpgXmlForChannels: vi.fn(),
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val), // Simple pass-through for test
}));

vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
  safeLookup: vi.fn((hostname, options, callback) => callback(null, '127.0.0.1', 4)),
  providerSourceKey: vi.fn(url => `source:${url}`),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
  EPG_DB_PATH: '/tmp/epg.db',
}));

// Import the controller after mocking
import { playerChannelsJson } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';
import { channelsJsonCache } from '../../src/services/cacheService.js';

describe('xtreamController - playerChannelsJson', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();
    channelsJsonCache.clear();
    req = {
      query: {},
      params: {},
      hostname: 'localhost',
      secure: false,
    };
    res = {
      json: vi.fn(),
      send: vi.fn(),
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

    mockDb.prepare.mockReturnValue({ iterate: vi.fn().mockReturnValue([movieChannel]) });

    await playerChannelsJson(req, res);

    expect(res.send).toHaveBeenCalled();
    const outputStr = res.send.mock.calls[0][0];
    const output = JSON.parse(outputStr);

    expect(output.length).toBe(1);
    expect(output[0].plot).toBe('Line 1\nLine 2'); // No newline replacement for JSON
    expect(output[0].rating).toBe(8.5); // Number ok
    expect(output[0].duration).toBe(120); // Number ok
    expect(output[0].cast).toBe('Actor A');
    expect(output[0].type).toBe('movie');
    expect(output[0].url).toContain('/movie/token/auth/100.mp4');
  });

  it('should expose DASH live streams as MPD manifest URLs', async () => {
    req.query.token = 'dash-test';
    const user = { id: 1, is_share_guest: false };
    getXtreamUser.mockResolvedValue(user);

    const dashChannel = {
      user_channel_id: 101,
      name: 'Dash Channel',
      logo: '',
      epg_channel_id: 'dash1',
      manual_epg_id: null,
      stream_type: 'live',
      mime_type: 'DASH',
      category_name: 'Live',
      tv_archive: 0,
      tv_archive_duration: 0,
    };

    mockDb.prepare.mockReturnValue({ iterate: vi.fn().mockReturnValue([dashChannel]) });

    await playerChannelsJson(req, res);

    const output = JSON.parse(res.send.mock.calls[0][0]);

    expect(output[0].url).toBe('http://localhost/live/mpd/token/auth/101/manifest.mpd?token=dash-test');
    expect(output[0].container_extension).toBe('mpd');
  });

  it('emits synchronized series episodes only through compact aliases', async () => {
    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: false });
    const channels = [
      {
        user_channel_id: 42,
        remote_stream_id: 500,
        provider_id: 7,
        provider_url: 'http://panel.test',
        name: 'Synced',
        stream_type: 'series',
        category_name: 'Series',
      },
      {
        user_channel_id: 43,
        remote_stream_id: 501,
        provider_id: 7,
        provider_url: 'http://panel.test',
        name: 'Unsynced',
        stream_type: 'series',
        category_name: 'Series',
      },
    ];

    mockDb.prepare.mockImplementation(sql => {
      if (sql.includes('FROM provider_series_episodes')) {
        return {
          all: vi.fn((_sourceKey, seriesId) => seriesId === 500
            ? [{ remote_episode_id: 9, season: 1, episode_num: 2, container_extension: '.MKV', logo: '' }]
            : []),
        };
      }
      if (sql.includes('INSERT OR IGNORE INTO series_episode_aliases')) return { run: vi.fn() };
      if (sql.includes('SELECT id FROM series_episode_aliases')) return { get: vi.fn(() => ({ id: 900000009 })) };
      return { iterate: vi.fn(() => channels) };
    });

    await playerChannelsJson(req, res);

    const output = JSON.parse(res.send.mock.calls[0][0]);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      name: 'Synced S01 E02',
      type: 'series',
      container_extension: 'mkv',
      url: 'http://localhost/series/token/auth/900000009.mkv',
    });
    expect(JSON.stringify(output)).not.toContain('/42.');
    expect(JSON.stringify(output)).not.toContain('/43.');
  });
});
