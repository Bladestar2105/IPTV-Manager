import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetBackup = vi.fn();
const mockSelectUserCategories = vi.fn();
const mockSelectAuthorizedProviderChannels = vi.fn();
const mockDeleteUserChannels = vi.fn();
const mockUpdateMappings = vi.fn();
const mockDeleteCategories = vi.fn();
const mockInsertCategory = vi.fn();
const mockInsertChannel = vi.fn();
const mockUpdateMapping = vi.fn();

vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn((sql) => {
      if (sql.includes('SELECT * FROM user_backups')) return { get: mockGetBackup };
      if (sql.includes('SELECT uc.provider_channel_id')) return { all: mockSelectAuthorizedProviderChannels };
      if (sql.includes('SELECT id FROM user_categories')) return { all: mockSelectUserCategories };
      if (sql.includes('DELETE FROM user_channels')) return { run: mockDeleteUserChannels };
      if (sql.includes('UPDATE category_mappings SET user_category_id = NULL')) return { run: mockUpdateMappings };
      if (sql.includes('DELETE FROM user_categories')) return { run: mockDeleteCategories };
      if (sql.includes('INSERT INTO user_categories')) return { run: mockInsertCategory };
      if (sql.includes('INSERT INTO user_channels')) return { run: mockInsertChannel };
      if (sql.includes('UPDATE category_mappings SET user_category_id = ?')) return { run: mockUpdateMapping };
      return { run: vi.fn(), all: vi.fn(), get: vi.fn() };
    }),
    transaction: vi.fn((fn) => fn)
  }
}));

import * as backupController from '../../src/controllers/backupController.js';

describe('backupController.restoreBackup security behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectUserCategories.mockReturnValue([{ id: 10 }]);
    mockSelectAuthorizedProviderChannels.mockReturnValue([{ provider_channel_id: 1 }]);

    mockGetBackup.mockReturnValue({
      id: 9001,
      user_id: 2,
      data: JSON.stringify({
        userCategories: [{ id: 10, user_id: 2, name: 'News', sort_order: 1, is_adult: 0, type: 'live' }],
        userChannels: [
          { id: 1000, user_category_id: 10, provider_channel_id: 1, sort_order: 1 },
          { id: 1001, user_category_id: 10, provider_channel_id: 999, sort_order: 2 }
        ],
        categoryMappings: []
      })
    });
  });

  it('allows non-admin self-restore but filters out revoked provider channels', () => {
    const req = { params: { userId: '2', id: '9001' }, user: { id: 2, is_admin: false } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    backupController.restoreBackup(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockGetBackup).toHaveBeenCalledWith(9001, 2);
    expect(mockInsertChannel).toHaveBeenCalledTimes(1);
    expect(mockInsertChannel).toHaveBeenCalledWith(1000, 10, 1, 1);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('allows admin users to restore all backed up channels', () => {
    const req = { params: { userId: '2', id: '9001' }, user: { id: 1, is_admin: true } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    backupController.restoreBackup(req, res);

    expect(mockGetBackup).toHaveBeenCalledWith(9001, 2);
    expect(mockSelectAuthorizedProviderChannels).not.toHaveBeenCalled();
    expect(mockInsertChannel).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
