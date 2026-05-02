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

vi.mock('../../src/utils/helpers.js', () => ({
  getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
  safeLookup: vi.fn((hostname, options, callback) => callback(null, '127.0.0.1', 4)),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
  EPG_DB_PATH: '/tmp/epg.db',
}));

import { getXtreamUser } from '../../src/services/authService.js';
import { getEpgXmlForChannels } from '../../src/services/epgService.js';
import { getPlaylist, playerApi, xmltv } from '../../src/controllers/xtreamController.js';

describe('xtreamController share compatibility', () => {
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
      send: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      sendStatus: vi.fn(),
    };
  });

  it('serves share M3U via token-auth URLs with metadata-friendly header', async () => {
    req.query = { token: 'share-token', type: 'm3u_plus' };
    getXtreamUser.mockResolvedValue({
      id: 1,
      is_share_guest: true,
      allowed_channels: [100],
      share_start: null,
      share_end: null
    });

    mockDb.prepare.mockReturnValue({
      iterate: vi.fn().mockReturnValue([
        {
          user_channel_id: 100,
          custom_name: 'News HD',
          user_category_id: 8,
          name: 'News',
          logo: 'http://logo.test/logo.png',
          epg_channel_id: 'news.epg',
          manual_epg_id: null,
          stream_type: 'live',
          mime_type: 'ts',
          category_name: 'Live',
          tv_archive: 0,
          tv_archive_duration: 0
        }
      ])
    });

    await getPlaylist(req, res);

    const payload = res.write.mock.calls.map(call => call[0]).join('');
    expect(payload).toContain('url-tvg="http://localhost/xmltv.php?token=share-token"');
    expect(payload).toContain('http://localhost/live/token/auth/100.ts?token=share-token');
  });

  it('serves Xtream metadata for active share tokens', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    req.query = { token: 'share-token' };
    getXtreamUser.mockResolvedValue({
      id: 1,
      is_share_guest: true,
      allowed_channels: [100],
      share_start: nowSec - 300,
      share_end: nowSec + 600,
      max_connections: 1
    });

    await playerApi(req, res);

    expect(res.sendStatus).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      user_info: expect.objectContaining({
        auth: 1,
        valid_from: String(nowSec - 300),
        valid_until: String(nowSec + 600),
        is_valid_now: 1
      })
    }));
  });

  it('returns updated validity window on subsequent metadata checks', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    req.query = { token: 'share-token' };

    getXtreamUser.mockResolvedValueOnce({
      id: 1,
      is_share_guest: true,
      allowed_channels: [100],
      share_start: nowSec - 120,
      share_end: nowSec + 120,
      max_connections: 1
    });

    await playerApi(req, res);
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({
      user_info: expect.objectContaining({
        valid_from: String(nowSec - 120),
        valid_until: String(nowSec + 120),
        is_valid_now: 1
      })
    }));

    getXtreamUser.mockResolvedValueOnce({
      id: 1,
      is_share_guest: true,
      allowed_channels: [100],
      share_start: nowSec + 240,
      share_end: nowSec + 900,
      max_connections: 1
    });

    await playerApi(req, res);
    expect(res.json).toHaveBeenLastCalledWith(expect.objectContaining({
      user_info: expect.objectContaining({
        valid_from: String(nowSec + 240),
        valid_until: String(nowSec + 900),
        is_valid_now: 0
      })
    }));
  });

  it('serves XMLTV for shares and limits it to share channels', async () => {
    req.query = { token: 'share-token' };
    getXtreamUser.mockResolvedValue({
      id: 1,
      is_share_guest: true,
      allowed_channels: [100, 101],
      share_start: null,
      share_end: null
    });

    mockDb.prepare.mockReturnValue({
      iterate: vi.fn().mockReturnValue([{ epg_id: 'news.epg' }])
    });

    getEpgXmlForChannels.mockImplementation(async function* () {
      yield '<channel id="news.epg"></channel>\n';
    });

    await xmltv(req, res);

    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('uc.id IN (?,?)'));
    const xml = res.write.mock.calls.map(call => call[0]).join('');
    expect(xml).toContain('<channel id="news.epg">');
  });
});
