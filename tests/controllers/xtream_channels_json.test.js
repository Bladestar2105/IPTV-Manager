import { decryptClientGrant } from '../helpers/clientResourceGrant.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockDb, mockEpgDb } = vi.hoisted(() => {
  return {
    mockDb: {
      prepare: vi.fn(),
    },
    mockEpgDb: {
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    },
  };
});

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
  openDbConnection: vi.fn(() => ({ prepare: mockDb.prepare, close: vi.fn() })),
}));

vi.mock('../../src/database/epgDb.js', () => ({
  default: mockEpgDb,
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

vi.mock('../../src/utils/crypto.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, decrypt: vi.fn(value => /^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/i.test(value)
    ? actual.decrypt(value) : value) };
});

vi.mock('../../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
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


  it.each([
    ['license', 'https://selected.test/panel/license'],
    ['/widevine/license', 'https://selected.test/widevine/license'],
    ['//licenses.test/license', 'https://licenses.test/license'],
  ])('protects relative license %s and Kodi headers for live and movie channels', async (key, expectedUrl) => {
    getXtreamUser.mockResolvedValue({ id: 1 });
    for (const stream_type of ['live', 'movie']) {
      vi.clearAllMocks();
      channelsJsonCache.clear();
      getXtreamUser.mockResolvedValue({ id: 1 });
      mockDb.prepare.mockReturnValue({ iterate: () => [{
        user_channel_id: 100, name: 'Channel', stream_type, mime_type: 'mp4',
        provider_url: 'https://selected.test/panel/', provider_id: 7,
        drm_license_key: `${key}|Authorization=Bearer%20secret-token|R{SSM}|JBlicense`,
      }] });
      await playerChannelsJson(req, res);
      const license = JSON.parse(res.send.mock.calls[0][0])[0].drm.license_key;
      expect(license).toMatch(/^http:\/\/localhost\/api\/proxy\/resource\//);
      expect(license).not.toContain('secret-token');
      expect(license).toContain('||R{SSM}|JBlicense');
      expect(await decryptClientGrant(license)).toMatchObject({
        url: expectedUrl, channelId: 100, providerId: 7, kind: 'license',
        headers: { Authorization: 'Bearer secret-token' },
      });
    }
  });


  it.each([
    '{"keys":[{"kty":"oct","kid":"AAAAAAAAAAAAAAAAAAAAAA","k":"BBBBBBBBBBBBBBBBBBBBBA"}],"type":"temporary"}',
    '00112233445566778899aabbccddeeff:ffeeddccbbaa99887766554433221100',
  ])('preserves validated inline ClearKey material: %s', async key => {
    getXtreamUser.mockResolvedValue({ id: 1 });
    mockDb.prepare.mockReturnValue({ iterate: () => [{
      user_channel_id: 100, name: 'Channel', stream_type: 'live',
      provider_url: 'https://selected.test/panel', drm_license_type: 'org.w3.clearkey', drm_license_key: key,
    }] });
    await playerChannelsJson(req, res);
    expect(JSON.parse(res.send.mock.calls[0][0])[0].drm.license_key).toBe(key);
  });

  it.each(['{"keys":[{"kty":"oct","kid":"https://secret-token","k":"BBBBBBBBBBBBBBBBBBBBBA"}]}', '|Authorization=secret-token', 'javascript:secret-token', 'data:text/plain,secret-token', 'https://[invalid|Authorization=secret-token', '/license||%ZZ', '/license||https%3A%2F%2Fsecret-token'])('fails closed for invalid license %s', async key => {
    getXtreamUser.mockResolvedValue({ id: 1 });
    mockDb.prepare.mockReturnValue({ iterate: () => [{
      user_channel_id: 100, name: 'Channel', stream_type: 'live',
      provider_url: 'https://selected.test/panel', drm_license_key: key,
    }] });
    await playerChannelsJson(req, res);
    expect(JSON.parse(res.send.mock.calls[0][0])[0].drm.license_key).toBe('');
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
      drm_license_type: 'com.widevine.alpha',
      drm_license_key: 'https://provider.test/license|Content-Type=application%2Fjson&Authorization=secret-token|R{SSM}|JBlicense',
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
    expect(output[0].drm.license_key).toMatch(/^http:\/\/localhost\//);
    expect(outputStr).not.toContain('https://provider.test');
    expect(outputStr).not.toContain('secret-token');
    expect(output[0].drm.license_key).toContain('||R{SSM}|JBlicense');
    expect(await decryptClientGrant(output[0].drm.license_key)).toMatchObject({ channelId: 100, kind: 'license' });
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
        drm_license_key: '/series-license|Authorization=Bearer%20secret-token|R{SSM}|JBlicense',
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
            ? [{ remote_episode_id: 9, season: 1, episode_num: 2, container_extension: '.MKV', logo: 'logo.png' }]
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
    expect(await decryptClientGrant(output[0].logo)).toMatchObject({ url: 'http://panel.test/logo.png', channelId: 42, providerId: 7, kind: 'image' });
    expect(await decryptClientGrant(output[0].drm.license_key)).toMatchObject({ url: 'http://panel.test/series-license', channelId: 42, providerId: 7, kind: 'license', headers: { Authorization: 'Bearer secret-token' } });
    expect(output[0].drm.license_key).toContain('||R{SSM}|JBlicense');
    expect(JSON.stringify(output)).not.toContain('secret-token');
    expect(JSON.stringify(output)).not.toContain('/42.');
    expect(JSON.stringify(output)).not.toContain('/43.');
  });
});
