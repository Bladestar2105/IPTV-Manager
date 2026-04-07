import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      run: vi.fn()
    }))
  }
}));

vi.mock('../../src/services/streamManager.js', () => ({
  default: {
    getAll: vi.fn(),
    remove: vi.fn()
  }
}));

vi.mock('../../src/services/syncService.js', () => ({
  calculateNextSync: vi.fn()
}));

vi.mock('../../src/services/logoResolver.js', () => ({
  getEpgLogo: vi.fn(() => null),
  loadEpgLogosCache: vi.fn()
}));

vi.mock('systeminformation', () => ({
  default: {
    networkStats: vi.fn().mockResolvedValue([{ operstate: 'up', rx_bytes: 0, tx_bytes: 0 }])
  }
}));

import * as systemController from '../../src/controllers/systemController.js';
import streamManager from '../../src/services/streamManager.js';

describe('systemController.terminateActiveStream', () => {
  let req;
  let res;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      user: { is_admin: true },
      params: { streamId: 'stream-123' }
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
  });

  it('returns 403 for non-admin users', async () => {
    req.user.is_admin = false;

    await systemController.terminateActiveStream(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
  });

  it('returns 404 when stream does not exist', async () => {
    streamManager.getAll.mockResolvedValue([{ id: 'other-stream' }]);

    await systemController.terminateActiveStream(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Stream not found' });
  });

  it('terminates matching stream and returns success', async () => {
    streamManager.getAll.mockResolvedValue([{ id: 'stream-123' }]);

    await systemController.terminateActiveStream(req, res);

    expect(streamManager.remove).toHaveBeenCalledWith('stream-123');
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
