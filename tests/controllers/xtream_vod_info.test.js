import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const { mockDb, mockFetch } = vi.hoisted(() => {
  return {
    mockDb: {
      prepare: vi.fn(),
    },
    mockFetch: vi.fn(),
  };
});

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
}));

vi.mock('node-fetch', () => ({
  default: mockFetch,
}));

vi.mock('../../src/services/authService.js', () => ({
  getXtreamUser: vi.fn(),
}));

vi.mock('../../src/services/epgService.js', () => ({
  getEpgPrograms: vi.fn(),
  getEpgXmlForChannels: vi.fn(),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
}));

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val), // Simple pass-through for test
}));

// Import the controller after mocking
import { playerApi } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('xtreamController - get_vod_info', () => {
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
    };
  });

  it('should return empty object if vod_id is missing', async () => {
    req.query = {
      action: 'get_vod_info',
    };
    getXtreamUser.mockResolvedValue({ id: 1, is_share_guest: false });

    await playerApi(req, res);

    expect(res.json).toHaveBeenCalledWith({});
  });

  it('should return movie info and update stream_id correctly', async () => {
    const user = { id: 1, is_share_guest: false };
    const vodId = 100;
    const remoteVodId = 555;
    const providerUrl = 'http://provider.com';

    req.query = {
      action: 'get_vod_info',
      vod_id: String(vodId),
    };

    getXtreamUser.mockResolvedValue(user);

    const channelData = {
      user_channel_id: vodId,
      remote_stream_id: remoteVodId,
      url: providerUrl,
      username: 'user',
      password: 'enc_password',
      provider_id: 10,
    };

    const mockGet = vi.fn().mockReturnValue(channelData);
    mockDb.prepare.mockReturnValue({ get: mockGet });

    const upstreamResponse = {
      info: { title: 'Test Movie' },
      movie_data: {
        stream_id: remoteVodId, // Should be replaced
        container_extension: 'mp4',
      },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => upstreamResponse,
    });

    await playerApi(req, res);

    expect(mockDb.prepare).toHaveBeenCalled();
    // Verify DB query args
    expect(mockGet).toHaveBeenCalledWith(vodId, user.id);

    // Verify Fetch call
    const expectedFetchUrl = `${providerUrl}/player_api.php?username=${channelData.username}&password=${channelData.password}&action=get_vod_info&vod_id=${remoteVodId}`;
    expect(mockFetch).toHaveBeenCalledWith(expectedFetchUrl);

    // Verify response
    expect(res.json).toHaveBeenCalledWith({
      info: { title: 'Test Movie' },
      movie_data: {
        stream_id: vodId, // Replaced with user_channel_id
        container_extension: 'mp4',
      },
    });
  });

  it('should return empty object if channel not found', async () => {
    req.query = {
      action: 'get_vod_info',
      vod_id: '999',
    };
    getXtreamUser.mockResolvedValue({ id: 1 });

    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

    await playerApi(req, res);

    expect(res.json).toHaveBeenCalledWith({});
  });

  it('should return empty object if upstream fails', async () => {
    req.query = {
      action: 'get_vod_info',
      vod_id: '100',
    };
    getXtreamUser.mockResolvedValue({ id: 1 });

    const channelData = {
      user_channel_id: 100,
      remote_stream_id: 555,
      url: 'http://provider.com',
      username: 'user',
      password: 'enc_password',
    };
    mockDb.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(channelData) });

    mockFetch.mockResolvedValue({ ok: false });

    await playerApi(req, res);

    expect(res.json).toHaveBeenCalledWith({});
  });
});
