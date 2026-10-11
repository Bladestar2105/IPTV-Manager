import { Writable } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    prepare: vi.fn(),
  },
}));

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
  openDbConnection: vi.fn(() => ({ prepare: mockDb.prepare, close: vi.fn() })),
}));

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn(),
}));

vi.mock('../../src/services/epgService.js', () => ({
  getEpgPrograms: vi.fn(),
  getEpgProgramsForChannels: vi.fn(),
  getEpgProgramsPage: vi.fn(),
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
import { getEpgPrograms, getEpgProgramsForChannels, getEpgProgramsPage } from '../../src/services/epgService.js';
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
    const chunks = [];
    res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    res.body = () => JSON.parse(Buffer.concat(chunks).toString());
    res.json = vi.fn();
    res.status = vi.fn().mockReturnThis();
    res.setHeader = vi.fn();
    getEpgProgramsForChannels.mockReturnValue(new Map());
    getEpgProgramsPage.mockImplementation((id, _start, _end, size, offset) => (
      (getEpgProgramsForChannels().get(id) || []).slice(offset, offset + size)
    ));
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
    expect(getEpgProgramsPage).toHaveBeenCalledWith('news.epg', dayStart, dayStart + 86400, 128, 0);
    expect(getEpgProgramsPage).toHaveBeenCalledWith('sports.manual', dayStart, dayStart + 86400, 128, 0);

    expect(res.body()).toEqual({
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

  it('serves every requested stream ID across SQLite query chunks', async () => {
    const ids = Array.from({ length: 6001 }, (_, index) => index + 1);
    req.query.stream_ids = [...ids, 1, 'bad', 0, -1].join(',');
    getXtreamUser.mockResolvedValue({ id: 7, is_share_guest: false });
    const all = vi.fn().mockImplementation((...params) => params.slice(0, -1).map((id) => ({
      user_channel_id: id, epg_channel_id: `guide.${id}`, manual_epg_id: null,
    })));
    mockDb.prepare.mockReturnValue({ all });
    const programs = Array.from({ length: 1201 }, (_, index) => ({
      start: 1777705200 + index, stop: 1777705201 + index,
      title: `Program ${index}`, desc: '', channel_id: 'guide.6001',
    }));
    getEpgProgramsForChannels.mockReturnValue(new Map([['guide.6001', programs]]));

    await playerApi(req, res);

    expect(all.mock.calls.flatMap((params) => params.slice(0, -1))).toEqual(ids);
    expect(all.mock.calls.every((params) => params.length <= 901 && params.at(-1) === 7)).toBe(true);
    const response = res.body();
    expect(Object.keys(response)).toHaveLength(6001);
    expect(response['201']).toEqual({ epg_listings: [] });
    expect(response['6001'].epg_listings).toHaveLength(1201);
    expect(response['6001'].epg_listings.at(-1).title).toBe(Buffer.from('Program 1200').toString('base64'));
    expect(getEpgProgramsPage.mock.calls.every((args) => args[3] <= 128)).toBe(true);
  });

  it('honors an explicit program limit without an artificial maximum', async () => {
    req.query.limit = '2500';
    getXtreamUser.mockResolvedValue({ id: 7, is_share_guest: false });
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { user_channel_id: 101, epg_channel_id: 'news.epg', manual_epg_id: null },
    ]) });
    const programs = Array.from({ length: 2600 }, (_, i) => ({ start: i, stop: i + 1, title: `Program ${i}` }));
    getEpgProgramsForChannels.mockReturnValue(new Map([['news.epg', programs]]));

    await playerApi(req, res);

    expect(res.body()['101'].epg_listings).toHaveLength(2500);
    expect(getEpgProgramsPage.mock.calls.every((args) => args[4] < 2500)).toBe(true);
  });

  it('stops paging when a slow client disconnects', async () => {
    getXtreamUser.mockResolvedValue({ id: 7, is_share_guest: false });
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([
      { user_channel_id: 101, epg_channel_id: 'news.epg', manual_epg_id: null },
    ]) });
    getEpgProgramsPage.mockImplementation((_id, _start, _end, size, offset) => (
      Array.from({ length: size }, (_, i) => ({
        start: offset + i, stop: offset + i + 1, title: 'Program', desc: 'x'.repeat(2048),
      }))
    ));
    const client = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) {
      setImmediate(() => { this.destroy(); done(); });
    } });
    client.setHeader = vi.fn();
    client.status = vi.fn();

    await playerApi(req, client);

    expect(client.destroyed).toBe(true);
    expect(getEpgProgramsPage.mock.calls.length).toBeLessThanOrEqual(1);
    expect(client.status).not.toHaveBeenCalled();
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
    expect(res.body()).toEqual({
      100: { epg_listings: [] },
    });
  });

  it.each(['get_simple_date_table', 'get_simple_data_table'])('returns full stream EPG for %s', async (action) => {
    req.query = {
      username: 'alice',
      password: 'secret',
      action,
      stream_id: '101',
    };

    getXtreamUser.mockResolvedValue({ id: 7, is_share_guest: false });
    mockDb.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        epg_channel_id: 'news.epg',
        manual_epg_id: null,
      }),
    });
    getEpgPrograms.mockReturnValue([{
      start: 1777705200,
      stop: 1777708800,
      start_fmt: '2026-05-02 07:00:00',
      stop_fmt: '2026-05-02 08:00:00',
      title: 'Morning News',
      desc: 'Headlines',
      lang: 'en',
      channel_id: 'news.epg',
    }]);

    await playerApi(req, res);

    expect(getEpgPrograms).toHaveBeenCalledWith('news.epg', 5000, { includePast: true });
    expect(res.json).toHaveBeenCalledWith({
      epg_listings: [expect.objectContaining({
        epg_id: 'news.epg',
        channel_id: 'news.epg',
        title: Buffer.from('Morning News').toString('base64'),
        description: Buffer.from('Headlines').toString('base64'),
      })],
    });
  });
});
