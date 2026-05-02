import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, getXtreamUserMock, getProgramsScheduleForChannelsMock } = vi.hoisted(() => ({
  mockDb: {
    prepare: vi.fn(),
  },
  getXtreamUserMock: vi.fn(),
  getProgramsScheduleForChannelsMock: vi.fn(),
}));

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
}));

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: getXtreamUserMock,
}));

vi.mock('../../src/services/epgService.js', () => ({
  loadAllEpgChannels: vi.fn(),
  updateEpgSource: vi.fn(),
  updateProviderEpg: vi.fn(),
  deleteEpgSourceData: vi.fn(),
  getProgramsNow: vi.fn(),
  getProgramsScheduleForChannels: getProgramsScheduleForChannelsMock,
  clearEpgData: vi.fn(),
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}));

vi.mock('../../src/utils/crypto.js', () => ({
  JWT_SECRET: 'test-secret',
}));

vi.mock('../../src/utils/helpers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isSafeUrl: vi.fn(),
  };
});

import { getEpgSchedule } from '../../src/controllers/epgController.js';

describe('epgController - getEpgSchedule scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProgramsScheduleForChannelsMock.mockReturnValue({
      json_data: '{"epg1":[{"title":"Now","start":10,"stop":20}]}',
    });
  });

  it('loads schedules only for visible EPG channel IDs belonging to the user', async () => {
    getXtreamUserMock.mockResolvedValue({ id: 7, is_share_guest: false });
    const all = vi.fn().mockReturnValue([{ epg_id: 'epg1' }, { epg_id: 'epg2' }]);
    mockDb.prepare.mockReturnValue({ all });
    const req = { headers: {}, query: { start: '10', end: '20' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      setHeader: vi.fn(),
    };

    await getEpgSchedule(req, res);

    expect(mockDb.prepare.mock.calls[0][0]).toContain('cat.user_id = ? AND uc.is_hidden = 0');
    expect(all).toHaveBeenCalledWith(7);
    expect(getProgramsScheduleForChannelsMock).toHaveBeenCalledWith(10, 20, new Set(['epg1', 'epg2']));
    expect(res.send).toHaveBeenCalledWith('{"epg1":[{"title":"Now","start":10,"stop":20}]}');
  });

  it('applies share guest channel restrictions before loading EPG', async () => {
    getXtreamUserMock.mockResolvedValue({
      id: 7,
      is_share_guest: true,
      allowed_channels: [100, '101', 'bad'],
    });
    const all = vi.fn().mockReturnValue([{ epg_id: 'epg1' }]);
    mockDb.prepare.mockReturnValue({ all });
    const req = { headers: {}, query: { start: '10', end: '20' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      setHeader: vi.fn(),
    };

    await getEpgSchedule(req, res);

    expect(mockDb.prepare.mock.calls[0][0]).toContain('uc.id IN (?,?)');
    expect(all).toHaveBeenCalledWith(7, 100, 101);
    expect(getProgramsScheduleForChannelsMock).toHaveBeenCalledWith(10, 20, new Set(['epg1']));
  });

  it('returns an empty schedule for expired share guests', async () => {
    getXtreamUserMock.mockResolvedValue({
      id: 7,
      is_share_guest: true,
      share_end: Math.floor(Date.now() / 1000) - 60,
      allowed_channels: [100],
    });
    const req = { headers: {}, query: { start: '10', end: '20' } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      setHeader: vi.fn(),
    };

    await getEpgSchedule(req, res);

    expect(mockDb.prepare).not.toHaveBeenCalled();
    expect(getProgramsScheduleForChannelsMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({});
  });
});
