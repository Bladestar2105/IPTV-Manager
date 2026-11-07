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
    remove: vi.fn(),
    recoverStoppedOwner: vi.fn()
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
    streamManager.remove.mockReset().mockResolvedValue(true);
    streamManager.recoverStoppedOwner.mockReset().mockResolvedValue(false);
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

  it('waits for the shared manager to terminate a foreign Redis owner', async () => {
    streamManager.getAll.mockResolvedValue([{ id: 'stream-123', worker_pid: process.pid + 100, owner_id: 'another-instance' }]);
    let finish;
    streamManager.remove.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = systemController.terminateActiveStream(req, res);
    await Promise.resolve();
    expect(res.json).not.toHaveBeenCalled();
    finish(true);
    await pending;
    expect(streamManager.remove).toHaveBeenCalledWith('stream-123');
    expect(res.json).toHaveBeenCalledWith({ success: true, forwarded: true });
  });

  it('does not report success when the owner did not acknowledge termination', async () => {
    streamManager.getAll.mockResolvedValue([{ id: 'stream-123', worker_pid: process.pid + 100 }]);
    streamManager.remove.mockResolvedValue(false);
    await systemController.terminateActiveStream(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('allows explicit recovery only after failed termination and exact stopped-owner confirmation', async () => {
    streamManager.getAll.mockResolvedValue([{ id: 'stream-123', owner_id: 'stopped-instance', worker_pid: 999999 }]);
    streamManager.remove.mockResolvedValue(false);
    streamManager.recoverStoppedOwner.mockResolvedValue(true);
    req.body = { confirm_owner_stopped: true, owner_id: 'stopped-instance' };
    await systemController.terminateActiveStream(req, res);
    expect(streamManager.recoverStoppedOwner).toHaveBeenCalledWith('stream-123', 'stopped-instance');
    expect(res.json).toHaveBeenCalledWith({ success: true, recovered: true });
  });

  it.each([{}, { owner_id: 'stopped-instance' }, { confirm_owner_stopped: true, owner_id: 'wrong-owner' }])('does not recover without matching explicit confirmation %j', async body => {
    streamManager.getAll.mockResolvedValue([{ id: 'stream-123', owner_id: 'stopped-instance' }]);
    streamManager.remove.mockResolvedValue(false);
    req.body = body;
    await systemController.terminateActiveStream(req, res);
    expect(streamManager.recoverStoppedOwner).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
