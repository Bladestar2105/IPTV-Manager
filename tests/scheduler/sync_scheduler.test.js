import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to ensure mockDb is available for mocking
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    prepare: vi.fn(),
    transaction: vi.fn(cb => cb()),
  },
}));

// Mock node-fetch to prevent resolution errors
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

// Mock dotenv
vi.mock('dotenv', () => ({
  default: {
    config: vi.fn(),
  },
}));

// Mock DB module
vi.mock('../../src/database/db.js', () => ({
  default: mockDb,
}));

// Mock syncService
vi.mock('../../src/services/syncService.js', () => ({
  performSync: vi.fn().mockResolvedValue({}),
}));

// Import after mocking
import { startSyncScheduler } from '../../src/services/schedulerService.js';
import * as syncService from '../../src/services/syncService.js';

describe('Sync Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should schedule syncs for due configs', async () => {
    const config = { id: 1, provider_id: 101, user_id: 201, enabled: 1, next_sync: 0 };

    mockDb.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([config]),
    });

    // Start the scheduler
    startSyncScheduler();

    // Advance time by 60 seconds (check interval)
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM sync_configs'));
    expect(syncService.performSync).toHaveBeenCalledWith(101, 201, false);
  });

  it('should not schedule concurrent syncs for the same config', async () => {
    const config = { id: 2, provider_id: 102, user_id: 202, enabled: 1, next_sync: 0 };

    mockDb.prepare.mockReturnValue({
      all: vi.fn().mockReturnValue([config]),
    });

    let resolveSync;
    const syncPromise = new Promise(resolve => { resolveSync = resolve; });

    vi.mocked(syncService.performSync).mockReturnValue(syncPromise);

    startSyncScheduler();

    // First tick
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncService.performSync).toHaveBeenCalledTimes(1);

    // Second tick - sync still running
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncService.performSync).toHaveBeenCalledTimes(1); // Should not increase

    // Resolve sync
    resolveSync({});
    // Wait for promise resolution
    await vi.advanceTimersByTimeAsync(1);

    // Third tick - sync finished
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncService.performSync).toHaveBeenCalledTimes(2); // Should trigger again
  });
});
