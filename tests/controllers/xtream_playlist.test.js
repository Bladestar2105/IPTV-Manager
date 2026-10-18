import { decryptClientGrant } from '../helpers/clientResourceGrant.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
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

vi.mock('../../src/services/logoResolver.js', () => ({
  getEpgLogo: vi.fn(() => null),
  loadEpgLogosCache: vi.fn(),
}));

vi.mock('../../src/utils/crypto.js', async importOriginal => ({
  ...(await importOriginal()),
  decrypt: vi.fn((val) => val), // Simple pass-through for test
}));

vi.mock('../../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
  safeLookup: vi.fn((hostname, options, callback) => callback(null, '127.0.0.1', 4)),
}));

vi.mock('../../src/config/constants.js', () => ({
  PORT: 3000,
  DATA_DIR: '/tmp',
  EPG_DB_PATH: '/tmp/epg.db',
}));

// Import the controller after mocking
import { playerPlaylist } from '../../src/controllers/xtreamController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('xtreamController - playerPlaylist', () => {
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
      getXtreamUser.mockResolvedValue({ id: 1 });
      mockDb.prepare.mockReturnValue({ iterate: () => [{
        user_channel_id: 100, name: 'Channel', stream_type, mime_type: 'mp4',
        provider_url: 'https://selected.test/panel/', provider_id: 7,
        drm_license_key: `${key}|Authorization=Bearer%20secret-token|R{SSM}|JBlicense`,
      }] });
      await playerPlaylist(req, res);
      const license = res.write.mock.calls.map(([chunk]) => chunk).join('').match(/#KODIPROP:inputstream\.adaptive\.license_key=([^\n]*)/)[1];
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
    await playerPlaylist(req, res);
    expect(res.write.mock.calls.map(([chunk]) => chunk).join('').match(/#KODIPROP:inputstream\.adaptive\.license_key=([^\n]*)/)[1]).toBe(key);
  });

  it.each(['{"keys":[{"kty":"oct","kid":"https://secret-token","k":"BBBBBBBBBBBBBBBBBBBBBA"}]}', '|Authorization=secret-token', 'javascript:secret-token', 'data:text/plain,secret-token', 'https://[invalid|Authorization=secret-token', '/license||%ZZ', '/license||https%3A%2F%2Fsecret-token'])('fails closed for invalid license %s', async key => {
    getXtreamUser.mockResolvedValue({ id: 1 });
    mockDb.prepare.mockReturnValue({ iterate: () => [{
      user_channel_id: 100, name: 'Channel', stream_type: 'live',
      provider_url: 'https://selected.test/panel', drm_license_key: key,
    }] });
    await playerPlaylist(req, res);
    expect(res.write.mock.calls.map(([chunk]) => chunk).join('').match(/#KODIPROP:inputstream\.adaptive\.license_key=([^\n]*)/)[1]).toBe('');
  });

  it('should generate M3U with metadata even with numeric values and newlines', async () => {
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
      drm_license_key: 'https://provider.test/license|Content-Type=application%2Fjson&Authorization=private-token|R{SSM}|JBlicense',
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

    await playerPlaylist(req, res);

    expect(res.write).toHaveBeenCalled();
    const output = res.write.mock.calls[0][0];

    // Check for attributes
    expect(output).toContain('plot="Line 1 Line 2"'); // Newline replaced
    expect(output).toContain('rating="8.5"'); // Numeric cast to string
    expect(output).toContain('duration="120"'); // Numeric cast to string
    expect(output).toContain('cast="Actor A"');
    expect(output).toContain('#KODIPROP:inputstream.adaptive.license_key=http://localhost/');
    expect(output).not.toContain('https://provider.test');
    expect(output).not.toContain('private-token');
    expect(output).toContain('||R{SSM}|JBlicense');
    const license = output.match(/#KODIPROP:inputstream\.adaptive\.license_key=([^\n]+)/)[1];
    expect(await decryptClientGrant(license)).toMatchObject({ channelId: 100, kind: 'license' });
  });
  it.each(['https://provider.test/extra', 'https%3A%2F%2Fprovider.test%2Fextra', '//provider.test/extra'])(
    'rejects a license transform that embeds an external resource: %s', async suffix => {
      getXtreamUser.mockResolvedValue({ id: 1 });
      mockDb.prepare.mockReturnValue({ iterate: () => [{
        user_channel_id: 100, name: 'Movie', stream_type: 'movie', mime_type: 'mp4',
        drm_license_key: `https://provider.test/license||${suffix}`,
      }] });
      await playerPlaylist(req, res);
      const output = res.write.mock.calls.map(([chunk]) => chunk).join('');
      expect(output).toContain('#KODIPROP:inputstream.adaptive.license_key=\n');
      expect(output).not.toContain('provider.test');
    }
  );

});
