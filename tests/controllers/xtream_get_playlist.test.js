import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const parityFixture = JSON.parse(
  readFileSync(new URL('../fixtures/protocol-parity.json', import.meta.url), 'utf8'),
);
const playableSeries = parityFixture.series.find(({ id }) => id === 'series-playable');
const unsynchronizedSeries = parityFixture.series.find(({ id }) => id === 'series-unsynchronized');
const fixtureMovie = parityFixture.movies.find(({ id }) => id === 'movie-1');

// Mock dependencies
const { mockDb, aliasDb } = vi.hoisted(() => {
  return {
    mockDb: {
      prepare: vi.fn(),
    },
    aliasDb: {
      prepare: vi.fn(),
      close: vi.fn(),
    },
  };
});

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
  openDbConnection: vi.fn(() => aliasDb),
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
    name: playableSeries.name,
    logo: 'series.png',
    epg_channel_id: '',
    manual_epg_id: null,
    stream_type: 'series',
    mime_type: 'mp4',
    category_name: playableSeries.categoryTitle,
    provider_id: 7,
    remote_stream_id: 555,
  };

  const seriesWithoutEpisodes = {
    ...seriesWithEpisodes,
    user_channel_id: 43,
    name: unsynchronizedSeries.name,
    remote_stream_id: 556,
  };

  const movieChannel = {
    user_channel_id: 100,
    custom_name: null,
    user_category_id: 5,
    name: fixtureMovie.name,
    logo: 'movie.png',
    epg_channel_id: '',
    manual_epg_id: null,
    stream_type: 'movie',
    mime_type: 'mkv',
    category_name: fixtureMovie.categoryTitle,
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
    episodes[0].container_extension = 'mkv';
    episodes[1].container_extension = 'mkv';
    movieChannel.mime_type = 'mkv';

    aliasDb.prepare.mockImplementation((sql) => {
      if (sql.includes('INSERT OR IGNORE INTO series_episode_aliases')) {
        return { run: vi.fn() };
      }
      if (sql.includes('SELECT id FROM series_episode_aliases')) {
        return {
          get: vi.fn((_userChannelId, _sourceKey, _seriesRemoteId, remoteEpisodeId) => ({
            id: remoteEpisodeId === 123 ? 900000501 : 900000502,
          })),
        };
      }
      throw new Error(`Unexpected alias SQL: ${sql}`);
    });

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

  it('expands series into one entry per episode with compact aliases', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(mockDb.prepare.mock.calls.some(([sql]) => sql.includes('JOIN authorized_user_channels uc'))).toBe(true);

    // Episode entries with SXX EXX naming
    expect(output).toContain(`tvg-name="${playableSeries.name} S01 E01"`);
    expect(output).toContain(`,${playableSeries.name} S01 E01\n`);
    expect(output).toContain(`tvg-name="${playableSeries.name} S01 E02"`);

    expect(output).toContain('http://localhost/series/u/p/900000501.mkv');
    expect(output).toContain('http://localhost/series/u/p/900000502.mkv');
    expect(aliasDb.close).toHaveBeenCalledTimes(1);

    // No series-level URL for the expanded series
    expect(output).not.toContain('/series/u/p/42.');

    // Episode logo used when present, series logo as fallback
    expect(output).toContain('tvg-logo="ep1.png"');
    expect(output.match(/tvg-logo="series\.png"/g).length).toBeGreaterThanOrEqual(1);

    // Category preserved on episode entries
    expect(output).toContain(`group-title="${playableSeries.categoryTitle}",${playableSeries.name} S01 E01`);
    expect(output).toContain('group-id="9"');
  });

  it('omits unsynchronized series instead of emitting a bare assignment URL', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).not.toContain(`tvg-name="${unsynchronizedSeries.name}"`);
    expect(output).not.toContain('/series/u/p/43.');
  });

  it('keeps movie entries unchanged', async () => {
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain(`tvg-name="${fixtureMovie.name}"`);
    expect(output).toContain('http://localhost/movie/u/p/100.mkv');
  });

  it('expands episodes in plain m3u mode without attributes', async () => {
    req.query.type = 'm3u';
    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain(`#EXTINF:-1,${playableSeries.name} S01 E01\n`);
    expect(output).toContain('http://localhost/series/u/p/900000501.mkv');
    expect(output).not.toContain('tvg-name="My Show S01 E01"');
  });

  it('cannot inject an extra playlist line through provider extensions', async () => {
    episodes[0].container_extension = 'mp4\r\n#EXTINF:-1,Injected';
    movieChannel.mime_type = 'mkv?token=secret';

    await getPlaylist(req, res);

    const output = collectOutput();
    expect(output).toContain('/series/u/p/900000501.mp4');
    expect(output).toContain('/movie/u/p/100.mp4');
    expect(output).not.toContain('Injected');
    expect(output).not.toContain('token=secret');
    expect(output.split('\n').filter(line => line.startsWith('#EXTINF')).length).toBe(3);
  });

  it('uses the sanitized fixture without expanding the protocol contract', () => {
    expect(parityFixture.live.filter(({ authorized }) => authorized)).toHaveLength(3);
    expect(parityFixture.live.filter(({ authorized }) => !authorized)).toHaveLength(1);
    expect(parityFixture.series.find(({ id }) => id === 'series-unsynchronized').episodes).toHaveLength(0);
    expect(parityFixture.playlist.filter(({ tvgId }) => tvgId === 'fixture.same')).toHaveLength(2);
  });
});
