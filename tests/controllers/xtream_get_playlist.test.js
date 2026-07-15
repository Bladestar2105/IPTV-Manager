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
  getEpgProgramsForChannels: vi.fn(),
  getEpgXmlForChannels: vi.fn(),
}));

vi.mock('../../src/services/logoResolver.js', () => ({
  getEpgLogo: vi.fn(() => null),
  loadEpgLogosCache: vi.fn(),
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val),
}));

vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
  safeLookup: vi.fn((hostname, options, callback) => callback(null, '127.0.0.1', 4)),
  providerSourceKey: vi.fn((url) => `key:${url}`),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
  EPG_DB_PATH: '/tmp/epg.db',
}));

// Import the controller after mocking
import { getPlaylist } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('xtreamController - getPlaylist (get.php)', () => {
  let req, res;

  const seriesWithEpisodes = {
    user_channel_id: 42,
    custom_name: null,
    user_category_id: 9,
    name: 'My Show',
    logo: 'series.png',
    epg_channel_id: '',
    manual_epg_id: null,
    stream_type: 'series',
    mime_type: 'mp4',
    category_name: 'Serien DE',
    provider_id: 7,
    remote_stream_id: 555,
  };

  const seriesWithoutEpisodes = {
    ...seriesWithEpisodes,
    user_channel_id: 43,
    name: 'Unsynced Show',
    remote_stream_id: 556,
  };

  const movieChannel = {
    user_channel_id: 100,
    custom_name: null,
    user_category_id: 5,
    name: 'Movie A',
    logo: 'movie.png',
    epg_channel_id: '',
    manual_epg_id: null,
    stream_type: 'movie',
    mime_type: 'mkv',
    category_name: 'Filme',
    provider_id: 7,
    remote_stream_id: 900,
  };

  const episodes = [
    { remote_episode_id: 123, season: 1, episode_num: 1, container_extension: 'mkv', logo: 'ep1.png' },
    { remote_episode_id: 124, season: 1, episode_num: 2, container_extension: 'mkv', logo: '' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      query: { username: 'u', password: 'p', type: 'm3u_plus', output: 'ts' },
      params: {},
      hostname: 'localhost',
      secure: false,
    };
    res = {
      send: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      sendStatus: vi.fn(),
    };

    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: false });

    mockDb.prepare.mockImplementation((sql) => {
      if (sql.includes('provider_series_episodes')) {
        return {
          all: vi.fn((sourceKey, seriesRemoteId) =>
            (sourceKey === 'key:http://prov.example' && seriesRemoteId === 555 ? episodes : [])),
        };
      }
      if (sql.includes('FROM providers')) {
        return {
          all: vi.fn().mockReturnValue([{ id: 7, url: 'http://prov.example' }]),
        };
      }
      return {
        iterate: vi.fn().mockReturnValue([seriesWithEpisodes, seriesWithoutEpisodes, movieChannel]),
      };
    });
  });

  const collectOutput = () => res.write.mock.calls.map((c) => c[0]).join('');

  it('expands series into one entry per episode with encoded episode IDs', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(mockDb.prepare.mock.calls.some(([sql]) => sql.includes('JOIN authorized_user_channels uc'))).toBe(true);

    // Episode entries with SXX EXX naming
    expect(output).toContain('tvg-name="My Show S01 E01"');
    expect(output).toContain(',My Show S01 E01\n');
    expect(output).toContain('tvg-name="My Show S01 E02"');

    // Encoded episode URL: providerId * 1e9 + remote_episode_id, episode container
    expect(output).toContain('http://localhost/series/u/p/7000000123.mkv');
    expect(output).toContain('http://localhost/series/u/p/7000000124.mkv');

    // No series-level URL for the expanded series
    expect(output).not.toContain('/series/u/p/42.');

    // Episode logo used when present, series logo as fallback
    expect(output).toContain('tvg-logo="ep1.png"');
    expect(output.match(/tvg-logo="series\.png"/g).length).toBeGreaterThanOrEqual(1);

    // Category preserved on episode entries
    expect(output).toContain('group-title="Serien DE",My Show S01 E01');
  });

  it('falls back to the legacy series entry when no episodes are synced', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain('tvg-name="Unsynced Show"');
    expect(output).toContain('http://localhost/series/u/p/43.mp4');
  });

  it('keeps movie entries unchanged', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain('tvg-name="Movie A"');
    expect(output).toContain('http://localhost/movie/u/p/100.mkv');
  });

  it('expands episodes in plain m3u mode without attributes', async () => {
    req.query.type = 'm3u';
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain('#EXTINF:-1,My Show S01 E01\n');
    expect(output).toContain('http://localhost/series/u/p/7000000123.mkv');
    expect(output).not.toContain('tvg-name="My Show S01 E01"');
  });
});
