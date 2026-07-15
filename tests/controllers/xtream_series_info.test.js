import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, upsertEpisode } = vi.hoisted(() => ({
  upsertEpisode: { run: vi.fn() },
  mockDb: {
    prepare: vi.fn(),
    transaction: vi.fn(callback => (...args) => callback(...args)),
  },
}));

vi.mock('../../src/database/db.js', () => ({ default: mockDb }));
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
vi.mock('../../src/utils/crypto.js', () => ({ decrypt: vi.fn(value => value) }));
vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn(() => 'http://localhost'),
  providerSourceKey: vi.fn(url => `source:${url}`),
}));
vi.mock('../../src/utils/network.js', () => ({ fetchSafe: vi.fn() }));
vi.mock('../../src/config/constants.js', () => ({ PORT: 3000 }));

import { playerApi } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';
import { fetchSafe } from '../../src/utils/network.js';

describe('Xtream get_series_info episode authorization', () => {
  const channel = {
    user_channel_id: 42,
    custom_name: 'Custom Series',
    remote_stream_id: 555,
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
    getChannel = vi.fn((seriesId, userId) => seriesId === 42 && userId === 1 ? channel : undefined);
    mockDb.prepare.mockImplementation(sql => {
      if (sql.includes('FROM authorized_user_channels uc')) return { get: getChannel };
      if (sql.includes('INSERT INTO provider_series_episodes')) return upsertEpisode;
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    fetchSafe.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        info: { name: 'Provider Series' },
        episodes: {
          1: [
            { id: 123, season: 1, episode_num: 1, title: 'Pilot', container_extension: 'mkv', added: '10' },
            { id: 'invalid', title: 'Invalid' },
          ],
        },
      }),
    });
  });

  it('emits assignment-bound IDs and persists the exact episode relationship', async () => {
    await playerApi(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.info.name).toBe('Custom Series');
    expect(payload.episodes[1]).toHaveLength(1);
    expect(payload.episodes[1][0].id).toBe('42000000123');
    expect(upsertEpisode.run).toHaveBeenCalledWith(
      'source:http://panel.test', 555, 123, 1, 1, 'Pilot', 'mkv', '', '10'
    );
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
