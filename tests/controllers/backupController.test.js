import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockRun = vi.fn();

vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn((sql) => {
      if (sql.includes('SELECT * FROM user_backups')) return { get: mockGet };
      if (sql.includes('SELECT id FROM user_categories')) return { all: vi.fn(() => []) };
      return { run: mockRun };
    }),
    transaction: vi.fn((fn) => fn)
  }
}));

import * as backupController from '../../src/controllers/backupController.js';

describe('backupController.restoreBackup authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockReturnValue({ id: 9001, user_id: 2, data: JSON.stringify({ userCategories: [], userChannels: [], categoryMappings: [] }) });
  });

  it('blocks non-admin users from restoring their own backup', () => {
    const req = { params: { userId: '2', id: '9001' }, user: { id: 2, is_admin: false } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    backupController.restoreBackup(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('allows admin users to restore backup for a target user', () => {
    const req = { params: { userId: '2', id: '9001' }, user: { id: 1, is_admin: true } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    backupController.restoreBackup(req, res);

    expect(mockGet).toHaveBeenCalledWith(9001, 2);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
