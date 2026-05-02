import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrepare, mockTransaction, insertChannelRun, insertProviderRun } = vi.hoisted(() => {
  const insertChannelRun = vi.fn();
  const insertProviderRun = vi.fn().mockReturnValue({ lastInsertRowid: 20 });
  return {
    insertChannelRun,
    insertProviderRun,
    mockPrepare: vi.fn(),
    mockTransaction: vi.fn((fn) => fn),
  };
});

vi.mock('../src/database/db.js', () => ({
  default: {
    prepare: mockPrepare,
    transaction: mockTransaction,
  },
}));

vi.mock('../src/services/cacheService.js', () => ({
  clearChannelsCache: vi.fn(),
}));

vi.mock('../src/services/authService.js', () => ({
  invalidateUserTokens: vi.fn(),
  invalidateUserCache: vi.fn(),
}));

vi.mock('../src/services/streamManager.js', () => ({
  default: {
    removeByUser: vi.fn(),
  },
}));

vi.mock('../src/utils/crypto.js', () => ({
  encrypt: vi.fn((value) => `encrypted:${value}`),
  decrypt: vi.fn((value) => value),
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('hashed-password'),
  },
}));

import * as userController from '../src/controllers/userController.js';

describe('User clone regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertProviderRun.mockReturnValue({ lastInsertRowid: 20 });
    insertChannelRun.mockImplementation((providerId, remoteStreamId, name) => {
      if (name == null) {
        throw new Error('NOT NULL constraint failed: provider_channels.name');
      }
      return { lastInsertRowid: 30 };
    });

    mockPrepare.mockImplementation((query) => {
      if (query.includes('FROM users WHERE username')) {
        return { get: vi.fn().mockReturnValue(null) };
      }
      if (query.includes('FROM admin_users WHERE username')) {
        return { get: vi.fn().mockReturnValue(null) };
      }
      if (query.startsWith('INSERT INTO users')) {
        return { run: vi.fn().mockReturnValue({ lastInsertRowid: 200 }) };
      }
      if (query.includes('SELECT id FROM users WHERE id')) {
        return { get: vi.fn().mockReturnValue({ id: 1 }) };
      }
      if (query.includes('SELECT * FROM providers WHERE user_id')) {
        return {
          all: vi.fn().mockReturnValue([{
            id: 10,
            name: 'Source provider',
            url: 'http://provider.test',
            username: 'source-user',
            password: 'source-password',
            epg_url: null,
            epg_update_interval: 86400,
            epg_enabled: 1,
            expiry_date: null,
            backup_urls: null,
            user_agent: null,
            max_connections: 0,
            use_mapped_epg_icon: 1,
          }]),
        };
      }
      if (query.includes('INSERT INTO providers')) {
        return { run: insertProviderRun };
      }
      if (query.includes('FROM sync_configs')) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      if (query.includes('INSERT OR IGNORE INTO sync_configs')) {
        return { run: vi.fn() };
      }
      if (query.includes('SELECT * FROM provider_channels')) {
        return {
          iterate: vi.fn(function* () {
            yield {
              id: 100,
              provider_id: 10,
              remote_stream_id: 123,
              name: null,
              original_category_id: 0,
              logo: '',
              stream_type: 'live',
              epg_channel_id: '',
              original_sort_order: 0,
              tv_archive: 0,
              tv_archive_duration: 0,
            };
          }),
        };
      }
      if (query.includes('INSERT INTO provider_channels')) {
        return { run: insertChannelRun };
      }
      if (query.includes('FROM epg_channel_mappings')) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      if (query.includes('INSERT OR IGNORE INTO epg_channel_mappings')) {
        return { run: vi.fn() };
      }
      if (query.includes('SELECT * FROM user_categories')) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      if (query.includes('INSERT INTO user_categories')) {
        return { run: vi.fn().mockReturnValue({ lastInsertRowid: 40 }) };
      }
      if (query.includes('SELECT * FROM category_mappings')) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      if (query.includes('INSERT OR IGNORE INTO category_mappings')) {
        return { run: vi.fn() };
      }
      if (query.includes('FROM user_channels uc')) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      if (query.includes('INSERT INTO user_channels')) {
        return { run: vi.fn() };
      }
      return {
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
        iterate: vi.fn(function* () {}),
      };
    });
  });

  it('creates cloned users even when legacy provider channels have no name', async () => {
    const req = {
      user: { is_admin: true },
      body: {
        username: 'newclone',
        password: 'password123',
        copy_from_user_id: '1',
      },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await userController.createUser(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      id: 200,
      message: 'User created successfully',
    });
    expect(insertChannelRun.mock.calls[0][2]).toBe('Channel 123');
    expect(insertProviderRun.mock.calls[0][12]).toBe(1);
  });
});
