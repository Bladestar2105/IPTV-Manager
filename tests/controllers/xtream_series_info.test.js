import { decryptClientGrant } from '../helpers/clientResourceGrant.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, upsertEpisode, insertAlias, selectAlias } = vi.hoisted(() => ({
  upsertEpisode: { run: vi.fn() },
  insertAlias: { run: vi.fn() },
  selectAlias: { get: vi.fn() },
  mockDb: {
    prepare: vi.fn(),
    transaction: vi.fn(callback => (...args) => callback(...args)),
  },
}));

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
  openDbConnection: vi.fn(() => ({ prepare: mockDb.prepare, close: vi.fn() })),
}));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser: vi.fn() }));
vi.mock('../../src/services/epgService.js', () => ({
  getEpgPrograms: vi.fn(),
  getEpgProgramsForChannels: vi.fn(),
  getEpgXmlForChannels: vi.fn(),
}));
vi.mock('../../src/services/cacheService.js', () => ({ channelsJsonCache: new Map() }));
vi.mock('../../src/services/episodeCache.js', () => ({ episodeNameCache: { set: vi.fn() } }));
vi.mock('../../src/services/logoResolver.js', () => ({
  getEpgLogo: vi.fn(),
  loadEpgLogosCache: vi.fn(),
}));
vi.mock('../../src/utils/crypto.js', async importOriginal => ({
  ...(await importOriginal()), decrypt: vi.fn(value => value) }));
vi.mock('../../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  getBaseUrl: vi.fn(() => 'http://localhost'),
  providerSourceKey: vi.fn(url => `source:${url}`),
}));
vi.mock('../../src/utils/network.js', async importOriginal => ({
  ...(await importOriginal()), fetchSafe: vi.fn() }));
vi.mock('../../src/config/constants.js', () => ({ PORT: 3000, DATA_DIR: '/tmp' }));

import { playerApi } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';
import { fetchSafe } from '../../src/utils/network.js';

describe('Xtream get_series_info episode authorization', () => {
  const channel = {
    user_channel_id: 42,
    custom_name: 'Custom Series',
    remote_stream_id: 555,
    provider_id: 7,
    url: 'http://panel.test',
    username: 'provider-user',
    password: 'provider-pass',
  };
  let req;
  let res;
  let getChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      query: { action: 'get_series_info', series_id: '42', username: 'user', password: 'pass' },
      headers: {},
      hostname: 'localhost',
      secure: false,
    };
    res = { json: vi.fn() };
    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: false });
    let aliasExists = false;
    insertAlias.run.mockImplementation(() => { aliasExists = true; });
    selectAlias.get.mockImplementation(() => aliasExists ? { id: 900000321 } : undefined);
    getChannel = vi.fn((seriesId, userId) => seriesId === 42 && userId === 1 ? channel : undefined);
    mockDb.prepare.mockImplementation(sql => {
      if (sql.includes('FROM authorized_user_channels uc')) return { get: getChannel };
      if (sql.includes('INSERT OR IGNORE INTO series_episode_aliases')) return insertAlias;
      if (sql.includes('SELECT id FROM series_episode_aliases')) return selectAlias;
      if (sql.includes('INSERT INTO provider_series_episodes')) return upsertEpisode;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    fetchSafe.mockResolvedValue({
      ok: true,
      url: 'https://cdn.example/details/series.json',
      json: vi.fn().mockResolvedValue({
        info: { name: 'Provider Series', subtitle: '../subs/en.vtt', cover: 'https://provider.test/private.jpg', backdrop_path: ['https://provider.test/backdrop.jpg'] },
        episodes: {
          1: [
            { id: 123, season: 1, episode_num: 1, title: 'Pilot', container_extension: 'mkv', added: '10', direct_source: 'https://provider.test/secret-stream', info: { movie_image: 'logo.png', youtube_trailer: 'https://youtu.be/public-trailer', drm: { license_key: '/episode-license|Authorization=Bearer%20secret-token|R{SSM}|JBlicense' } } },
            { id: 'invalid', title: 'Invalid' },
          ],
        },
      }),
    });
  });

  it('emits compact persistent aliases and persists the exact episode relationship', async () => {
    await playerApi(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.info.name).toBe('Custom Series');
    expect(await decryptClientGrant(payload.info.subtitle)).toMatchObject({ channelId: 42, url: 'https://cdn.example/subs/en.vtt' });
    expect(await decryptClientGrant(payload.info.backdrop_path[0])).toMatchObject({ channelId: 42, kind: 'image' });
    expect(await decryptClientGrant(payload.episodes[1][0].info.movie_image)).toMatchObject({ channelId: 42, kind: 'image', url: 'https://cdn.example/details/logo.png' });
    expect(await decryptClientGrant(payload.episodes[1][0].info.drm.license_key)).toMatchObject({ channelId: 42, providerId: 7, kind: 'license', url: 'https://cdn.example/episode-license', headers: { Authorization: 'Bearer secret-token' } });
    expect(payload.episodes[1][0].info.drm.license_key).toContain('||R{SSM}|JBlicense');
    expect(payload.episodes[1][0].info.youtube_trailer).toBe('https://youtu.be/public-trailer');
    expect(JSON.stringify(payload)).not.toContain('secret-token');
    expect(JSON.stringify(payload)).not.toContain('https://provider.test');
    expect(payload.episodes[1][0].direct_source).toBe('');
    expect(payload.episodes[1]).toHaveLength(1);
    expect(payload.episodes[1][0].id).toBe('900000321');
    expect(Number(payload.episodes[1][0].id)).toBeLessThan(2 ** 31);
    expect(insertAlias.run).toHaveBeenCalledWith(42, 'source:http://panel.test', 555, 123);
    expect(upsertEpisode.run).toHaveBeenCalledWith(
      'source:http://panel.test', 555, 123, 1, 1, 'Pilot', 'mkv', 'https://cdn.example/details/logo.png', '10'
    );
    expect(mockDb.prepare.mock.calls.find(([sql]) => sql.includes('INSERT INTO provider_series_episodes'))[0])
      .toContain('ON CONFLICT(source_key, series_remote_id, remote_episode_id)');
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.prepare.mock.calls[0][0]).toContain("pc.stream_type = 'series'");
  });

  it('rejects another user assignment before contacting the provider', async () => {
    getXtreamUser.mockResolvedValue({ id: 2, is_share_guest: false });

    await playerApi(req, res);

    expect(res.json).toHaveBeenCalledWith({});
    expect(fetchSafe).not.toHaveBeenCalled();
  });

  it('scopes share guests to the explicitly shared series', async () => {
    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: true, allowed_channels: [42] });
    await playerApi(req, res);
    expect(fetchSafe).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: true, allowed_channels: [43] });
    await playerApi(req, res);

    expect(res.json).toHaveBeenCalledWith({});
    expect(fetchSafe).not.toHaveBeenCalled();
  });
});
