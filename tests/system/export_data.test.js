import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as systemController from '../../src/controllers/systemController.js';
import db from '../../src/database/db.js';
import zlib from 'zlib';
import * as cryptoUtils from '../../src/utils/crypto.js';

// Mock dependencies
vi.mock('../../src/services/syncService.js', () => ({
  calculateNextSync: vi.fn(),
}));

vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn(),
    transaction: vi.fn((cb) => cb),
  },
}));

vi.mock('zlib', () => ({
  default: {
    gzipSync: vi.fn((data) => Buffer.from(`gzipped-${data}`)),
  },
}));

vi.mock('../../src/utils/crypto.js', () => ({
  encryptWithPassword: vi.fn((data, password) => Buffer.from(`encrypted-${data}-${password}`)),
  decrypt: vi.fn((pass) => `decrypted-${pass}`),
  // Add other exports if needed by other imports, but systemController only imports these from crypto.js
  decryptWithPassword: vi.fn(),
  encrypt: vi.fn(),
}));

describe('systemController.exportData', () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();

    req = {
      user: { is_admin: true },
      body: { password: 'export-password' },
      query: {},
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      send: vi.fn(),
      setHeader: vi.fn(),
    };

    // Default DB mock behavior: return empty results
    db.prepare.mockImplementation((query) => {
      return {
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
        run: vi.fn(),
      };
    });
  });

  it('should return 403 if user is not admin', () => {
    req.user.is_admin = false;
    systemController.exportData(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
  });

  it('should return 400 if password is missing', () => {
    req.body.password = undefined;
    req.query.password = undefined;
    systemController.exportData(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Password required for encryption' });
  });

  it('should return 404 if specific user is not found', () => {
    req.body.user_id = 999;

    // Mock user lookup returning null
    db.prepare.mockImplementation((query) => {
      if (query.includes('SELECT * FROM users WHERE id = ?')) {
        return { get: vi.fn().mockReturnValue(null) };
      }
      return { all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) };
    });

    systemController.exportData(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
  });

  it('should export all users with empty data if no related data exists', () => {
    const mockUsers = [{ id: 1, username: 'user1' }];

    db.prepare.mockImplementation((query) => {
      if (query.includes('SELECT * FROM users')) {
        return { all: vi.fn().mockReturnValue(mockUsers) };
      }
      // Default empty for other queries (providers, etc.)
      return { all: vi.fn().mockReturnValue([]) };
    });

    systemController.exportData(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
    expect(res.send).toHaveBeenCalled();

    // Verify what was encrypted
    const encryptCall = cryptoUtils.encryptWithPassword.mock.calls[0];
    const dataToEncrypt = encryptCall[0]; // This is the gzipped buffer mock
    // In our mock, gzipSync returns `gzipped-${jsonStr}`
    // We can't easily parse it back because of the mock string, but we can verify calls.

    expect(zlib.gzipSync).toHaveBeenCalled();
    const jsonStr = zlib.gzipSync.mock.calls[0][0];
    const exportData = JSON.parse(jsonStr);

    expect(exportData.users).toHaveLength(1);
    expect(exportData.users[0].username).toBe('user1');
    expect(exportData.providers).toHaveLength(0);
  });

  it('should export full data set for a user correctly', () => {
    req.body.user_id = 1;

    const mockUser = { id: 1, username: 'user1' };
    const mockProvider = { id: 10, user_id: 1, password: 'encrypted-pass' };
    const mockChannels = [{ id: 100, provider_id: 10, name: 'Channel 1' }];
    const mockMappings = [{ id: 200, provider_id: 10 }];
    const mockSyncs = [{ id: 300, provider_id: 10 }];
    const mockCategories = [{ id: 400, user_id: 1, name: 'Cat 1' }];
    const mockUserChannels = [{ id: 500, user_category_id: 400, name: 'UC 1' }];

    db.prepare.mockImplementation((query) => {
        const q = query.toLowerCase();
        if (q.includes('from users where id = ?')) {
            return { get: vi.fn().mockReturnValue(mockUser) };
        }
        if (q.includes('from providers where user_id in')) {
            return { all: vi.fn().mockReturnValue([mockProvider]) };
        }
        if (q.includes('from provider_channels where provider_id in')) {
            return { all: vi.fn().mockReturnValue(mockChannels) };
        }
        if (q.includes('from category_mappings where provider_id in')) {
            return { all: vi.fn().mockReturnValue(mockMappings) };
        }
        if (q.includes('from sync_configs where provider_id in')) {
            return { all: vi.fn().mockReturnValue(mockSyncs) };
        }
        if (q.includes('from user_categories where user_id in')) {
            return { all: vi.fn().mockReturnValue(mockCategories) };
        }
        // Complex query for user channels
        if (q.includes('select uc.*') && q.includes('from user_channels uc')) {
             return { all: vi.fn().mockReturnValue(mockUserChannels) };
        }

        return { all: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(null) };
    });

    systemController.exportData(req, res);

    expect(cryptoUtils.decrypt).toHaveBeenCalledWith('encrypted-pass');
    expect(zlib.gzipSync).toHaveBeenCalled();

    const jsonStr = zlib.gzipSync.mock.calls[0][0];
    const exportData = JSON.parse(jsonStr);

    expect(exportData.users).toHaveLength(1);
    expect(exportData.providers).toHaveLength(1);
    // Password should be decrypted
    expect(exportData.providers[0].password).toBe('decrypted-encrypted-pass');

    expect(exportData.channels).toHaveLength(2); // 1 provider channel + 1 user channel
    const userChannel = exportData.channels.find(c => c.type === 'user_assignment');
    expect(userChannel).toBeDefined();
    expect(userChannel.id).toBe(500);

    expect(exportData.mappings).toHaveLength(1);
    expect(exportData.sync_configs).toHaveLength(1);
    expect(exportData.categories).toHaveLength(1);
  });

  it('should use original password if decryption fails', () => {
    req.body.user_id = 1;
    const mockUser = { id: 1, username: 'user1' };
    const mockProvider = { id: 10, user_id: 1, password: 'plaintext-pass' };

    cryptoUtils.decrypt.mockReturnValue(null); // Simulate failure

    db.prepare.mockImplementation((query) => {
        const q = query.toLowerCase();
        if (q.includes('from users where id = ?')) return { get: vi.fn().mockReturnValue(mockUser) };
        if (q.includes('from providers')) return { all: vi.fn().mockReturnValue([mockProvider]) };
        return { all: vi.fn().mockReturnValue([]) };
    });

    systemController.exportData(req, res);

    const jsonStr = zlib.gzipSync.mock.calls[0][0];
    const exportData = JSON.parse(jsonStr);

    expect(exportData.providers[0].password).toBe('plaintext-pass');
  });

  it('should handle database errors gracefully', () => {
    const error = new Error('DB Error');
    db.prepare.mockImplementation(() => {
        throw error;
    });

    systemController.exportData(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'DB Error' });
  });
});
