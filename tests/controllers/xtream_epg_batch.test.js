import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    prepare: vi.fn(),
  },
}));

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
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

vi.mock('../../src/services/streamManager.js', () => ({
  default: {
    getUserConnectionCount: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
  EPG_DB_PATH: '/tmp/epg.db',
}));

import { getXtreamUser } from '../../src/services/authService.js';
import { getEpgProgramsForChannels } from '../../src/services/epgService.js';
import { playerApi } from '../../src/controllers/xtreamController.js';

describe('xtreamController get_epg_batch', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      query: {
        username: 'alice',
        password: 'secret',
        action: 'get_epg_batch',
        stream_ids: '101,102,101,bad',
        date: '2026-05-02',
      },
      params: {},
      hostname: 'localhost',
      secure: false,
    };
    res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    };
  });

  it('returns Xtream EPG listings for multiple stream IDs and a UTC day', async () => {
    getXtreamUser.mockResolvedValue({ id: 7, is_share_guest: false });

    const all = vi.fn().mockReturnValue([
      { user_channel_id: 101, epg_channel_id: 'news.epg', manual_epg_id: null },
      { user_channel_id: 102, epg_channel_id: 'sports.epg', manual_epg_id: 'sports.manual' },
    ]);
    mockDb.prepare.mockReturnValue({ all });

    getEpgProgramsForChannels.mockReturnValue(new Map([
      ['news.epg', [{
        start: 1777705200,
        stop: 1777708800,
        start_fmt: '2026-05-02 07:00:00',
        stop_fmt: '2026-05-02 08:00:00',
        title: 'Morning News',
        desc: 'Headlines',
        lang: 'en',
        channel_id: 'news.epg',
      }]],
      ['sports.manual', [{
        start: 1777712400,
        stop: 1777716000,
        start_fmt: '2026-05-02 09:00:00',
        stop_fmt: '2026-05-02 10:00:00',
        title: 'Matchday',
        desc: '',
        lang: '',
        channel_id: 'sports.manual',
      }]],
    ]));

    await playerApi(req, res);

    const dayStart = Math.floor(Date.parse('2026-05-02T00:00:00.000Z') / 1000);
    expect(all).toHaveBeenCalledWith(101, 102, 7);
    expect(getEpgProgramsForChannels).toHaveBeenCalledWith(expect.any(Set), dayStart, dayStart + 86400, 500);
    expect(Array.from(getEpgProgramsForChannels.mock.calls[0][0]).sort()).toEqual(['news.epg', 'sports.manual']);

    expect(res.json).toHaveBeenCalledWith({
      101: {
        epg_listings: [expect.objectContaining({
          epg_id: 'news.epg',
          channel_id: 'news.epg',
          title: Buffer.from('Morning News').toString('base64'),
          description: Buffer.from('Headlines').toString('base64'),
          start_timestamp: '1777705200',
          stop_timestamp: '1777708800',
        })],
      },
      102: {
        epg_listings: [expect.objectContaining({
          epg_id: 'sports.manual',
          title: Buffer.from('Matchday').toString('base64'),
          description: '',
        })],
      },
    });
  });

  it('limits batch EPG requests to share-visible stream IDs', async () => {
    req.query.stream_ids = '100,101';
    getXtreamUser.mockResolvedValue({
      id: 3,
      is_share_guest: true,
      allowed_channels: [100],
      share_start: null,
      share_end: null,
    });

    const all = vi.fn().mockReturnValue([
      { user_channel_id: 100, epg_channel_id: 'visible.epg', manual_epg_id: null },
    ]);
    mockDb.prepare.mockReturnValue({ all });
    getEpgProgramsForChannels.mockReturnValue(new Map());

    await playerApi(req, res);

    expect(all).toHaveBeenCalledWith(100, 3);
    expect(res.json).toHaveBeenCalledWith({
      100: { epg_listings: [] },
    });
  });
});
