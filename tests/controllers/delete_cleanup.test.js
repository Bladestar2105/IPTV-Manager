import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbCalls: [],
  db: {
    prepare: vi.fn(),
    transaction: vi.fn((fn) => () => fn())
  },
  clearChannelsCache: vi.fn()
}));

vi.mock('../../src/database/db.js', () => ({
  default: mocks.db
}));

vi.mock('../../src/services/cacheService.js', () => ({
  clearChannelsCache: mocks.clearChannelsCache
}));

vi.mock('../../src/services/authService.js', () => ({
  invalidateUserTokens: vi.fn(),
  invalidateUserCache: vi.fn()
}));

vi.mock('../../src/services/streamManager.js', () => ({
  default: {
    remove: vi.fn()
  }
}));

vi.mock('../../src/utils/crypto.js', () => ({
  encrypt: (value) => value,
  decrypt: (value) => value
}));

vi.mock('../../src/utils/network.js', () => ({
  fetchSafe: vi.fn()
}));

vi.mock('../../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn(),
  isAdultCategory: vi.fn(),
  providerSourceKey: vi.fn((url) => String(url || ''))
}));

vi.mock('../../src/services/syncService.js', () => ({
  performSync: vi.fn(),
  checkProviderExpiry: vi.fn()
}));

vi.mock('../../src/services/epgService.js', () => ({
  updateProviderEpg: vi.fn()
}));

vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn(),
    compare: vi.fn()
  }
}));

vi.mock('../../src/config/constants.js', () => ({
  BCRYPT_ROUNDS: 10
}));

const makeRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn()
});

const sqlIndex = (pattern) => mocks.dbCalls.findIndex((call) => call.sql.includes(pattern));

describe('delete cleanup regressions', () => {
  beforeEach(() => {
    mocks.dbCalls.length = 0;
    vi.clearAllMocks();
    mocks.db.prepare.mockImplementation((sql) => ({
      run: vi.fn((...params) => {
        mocks.dbCalls.push({ sql, params });
        return { changes: 1 };
      }),
      get: vi.fn(),
      all: vi.fn(() => []),
      iterate: vi.fn()
    }));
  });

  it('removes provider icon cache rows before deleting a provider', async () => {
    const { deleteProvider } = await import('../../src/controllers/providerController.js');
    const res = makeRes();

    deleteProvider({ user: { is_admin: true }, params: { id: '42' } }, res);

    const iconCacheIndex = sqlIndex('DELETE FROM provider_icon_cache WHERE provider_id = ?');
    const providerIndex = sqlIndex('DELETE FROM providers WHERE id = ?');

    expect(iconCacheIndex).toBeGreaterThanOrEqual(0);
    expect(providerIndex).toBeGreaterThan(iconCacheIndex);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('drops shared episode data only when the last provider of a panel is deleted', async () => {
    const { deleteProvider } = await import('../../src/controllers/providerController.js');

    // Another provider row still points at the same panel URL -> keep episodes
    mocks.db.prepare.mockImplementation((sql) => ({
      run: vi.fn((...params) => {
        mocks.dbCalls.push({ sql, params });
        return { changes: 1 };
      }),
      get: vi.fn(() => ({ url: 'http://panel.a' })),
      all: vi.fn(() => [{ id: 99, url: 'http://panel.a' }]),
      iterate: vi.fn()
    }));
    deleteProvider({ user: { is_admin: true }, params: { id: '42' } }, makeRes());
    expect(sqlIndex('DELETE FROM provider_series_episodes WHERE source_key = ?')).toBe(-1);

    // No provider row left for the panel -> episodes and state are removed
    mocks.dbCalls.length = 0;
    mocks.db.prepare.mockImplementation((sql) => ({
      run: vi.fn((...params) => {
        mocks.dbCalls.push({ sql, params });
        return { changes: 1 };
      }),
      get: vi.fn(() => ({ url: 'http://panel.a' })),
      all: vi.fn(() => []),
      iterate: vi.fn()
    }));
    deleteProvider({ user: { is_admin: true }, params: { id: '42' } }, makeRes());
    expect(sqlIndex('DELETE FROM provider_series_episodes WHERE source_key = ?')).toBeGreaterThanOrEqual(0);
    expect(sqlIndex('DELETE FROM provider_series_state WHERE source_key = ?')).toBeGreaterThanOrEqual(0);
  });

  it('removes user-owned FK rows before deleting a user', async () => {
    const { deleteUser } = await import('../../src/controllers/userController.js');
    const res = makeRes();

    deleteUser({ user: { is_admin: true }, params: { id: '7' } }, res);

    const iconCacheIndex = sqlIndex('DELETE FROM provider_icon_cache WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)');
    const providersIndex = sqlIndex('DELETE FROM providers WHERE user_id = ?');
    const sharedLinksIndex = sqlIndex('DELETE FROM shared_links WHERE user_id = ?');
    const userBackupsIndex = sqlIndex('DELETE FROM user_backups WHERE user_id = ?');
    const userIndex = sqlIndex('DELETE FROM users WHERE id = ?');

    expect(iconCacheIndex).toBeGreaterThanOrEqual(0);
    expect(providersIndex).toBeGreaterThan(iconCacheIndex);
    expect(sharedLinksIndex).toBeGreaterThanOrEqual(0);
    expect(userBackupsIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThan(sharedLinksIndex);
    expect(userIndex).toBeGreaterThan(userBackupsIndex);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
