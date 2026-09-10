import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define the mock implementation
const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      prepare: vi.fn(),
    },
  };
});

vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
  openDbConnection: vi.fn(() => ({ prepare: mockDb.prepare, close: vi.fn() })),
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

vi.mock('../../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val), // Simple pass-through for test
  encrypt: vi.fn((val) => val),
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

// Import the controller after mocking
import { getPlaylist, playerPlaylist } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('Security: M3U Injection', () => {
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
      send: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      status: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
      sendStatus: vi.fn(),
    };
  });

  it('should sanitize newlines in channel name and group title to prevent M3U injection', async () => {
    const user = { id: 1, is_share_guest: false };
    getXtreamUser.mockResolvedValue(user);

    const maliciousChannel = {
      user_channel_id: 666,
      name: 'Safe Name\n#EXTINF:-1,Malicious Channel\nhttp://evil.com/stream.ts',
      logo: 'logo.png',
      epg_channel_id: 'bad1',
      manual_epg_id: null,
      stream_type: 'live',
      mime_type: 'ts',
      category_name: 'Safe Group\n#EXT-X-KEY:METHOD=AES-128,URI="http://evil.com/key"',
      metadata: '{}',
      plot: '',
      cast: '',
      director: '',
      genre: '',
      releaseDate: '',
      rating: '',
      episode_run_time: ''
    };

    mockDb.prepare.mockReturnValue({ iterate: vi.fn().mockReturnValue([maliciousChannel]) });

    await playerPlaylist(req, res);

    expect(res.write).toHaveBeenCalled();
    const output = res.write.mock.calls[0][0];

    // Check that injection attempts are thwarted
    // Newlines should be replaced by spaces or removed
    expect(output).not.toContain('\n#EXTINF:-1,Malicious Channel');
    expect(output).not.toContain('\nhttp://evil.com/stream.ts');
    expect(output).not.toContain('\n#EXT-X-KEY');

    // Also check that the original content is somewhat preserved but sanitized
    expect(output).toContain('Safe Name');
    expect(output).toContain('Malicious Channel'); // It will be there, but on the same line (hopefully)
  });

  describe.each([
    ['get.php', getPlaylist],
    ['player playlist', playerPlaylist],
  ])('%s', (_name, playlist) => {
    it.each(['epg_channel_id', 'manual_epg_id'])('keeps %s inside its M3U attribute', async (field) => {
      getXtreamUser.mockResolvedValue({ id: 1 });
      req.query.type = 'm3u_plus';
      const channel = {
        user_channel_id: 1,
        name: 'Channel',
        stream_type: 'live',
        [field]: 'epg" injected="yes\r\n#EXTINF:-1,Injected\nhttps://evil.example/stream',
      };
      mockDb.prepare.mockReturnValue({ iterate: () => [channel], all: () => [] });

      await playlist(req, res);

      const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
      expect(output).toContain('tvg-id="epg injected=yes #EXTINF:-1,Injected https://evil.example/stream"');
      expect(output.split('\n').filter(line => line.startsWith('#EXTINF:'))).toHaveLength(1);
      expect(output).not.toContain('\nhttps://evil.example/stream');
      expect(res.end).toHaveBeenCalled();
    });
  });

  it.each(['drm_license_type', 'drm_license_key'])('keeps %s on one property line without changing quotes', async (field) => {
    getXtreamUser.mockResolvedValue({ id: 1 });
    const channel = {
      user_channel_id: 1,
      name: 'Channel',
      stream_type: 'live',
      [field]: '{"keys":[]}\r\n#EXTINF:-1,Injected\nhttps://evil.example/stream',
    };
    mockDb.prepare.mockReturnValue({ iterate: () => [channel] });

    await playerPlaylist(req, res);

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(output).toContain('={"keys":[]} #EXTINF:-1,Injected https://evil.example/stream\n');
    expect(output.split('\n').filter(line => line.startsWith('#EXTINF:'))).toHaveLength(1);
    expect(output).not.toContain('\nhttps://evil.example/stream');
  });
});
