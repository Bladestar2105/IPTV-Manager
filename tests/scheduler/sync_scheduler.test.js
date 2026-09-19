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
    // clearAllMocks clears calls, not implementations: a test that leaves
    // performSync returning a promise it alone can resolve keeps the module's
    // in-flight set full for every later test in this file.
    vi.mocked(syncService.performSync).mockResolvedValue({});
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
    expect(syncService.performSync).toHaveBeenCalledWith(101, 201, { mode: 'scheduled' });
  });

  it('starts at most SYNC_MAX_CONCURRENT catalog fetches per tick', async () => {
    // Reading a catalog holds its bytes, the decoded string and the parsed
    // object graph at once — several times a list that is itself hundreds of
    // megabytes. Every due config used to start in one un-awaited loop, and
    // next_sync values cluster after a restart or a shared upstream failure.
    const configs = [1, 2, 3, 4, 5].map(n => ({
      id: n, provider_id: 100 + n, user_id: 1, enabled: 1, next_sync: 0,
    }));
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(configs) });
    const pending = [];
    vi.mocked(syncService.performSync).mockImplementation(() => new Promise(resolve => pending.push(resolve)));

    startSyncScheduler();
    await vi.advanceTimersByTimeAsync(60000);

    expect(syncService.performSync).toHaveBeenCalledTimes(2);

    // The rest keep their next_sync, so a later tick simply picks them up.
    pending.shift()({});
    await vi.advanceTimersByTimeAsync(60000);
    expect(syncService.performSync).toHaveBeenCalledTimes(3);

    // Drain: the in-flight set lives in the module, so a run left pending would
    // keep the cap reached for every later test in this file.
    while (pending.length) pending.shift()({});
    await vi.advanceTimersByTimeAsync(1);
  });

  it('takes the longest overdue configs first, so none is starved by table order', async () => {
    // The scan returns rowid order, which is the same on every tick — with the
    // cap in place the head of the list would win every time.
    let sql = '';
    mockDb.prepare.mockImplementation(query => {
      sql = query;
      return { all: vi.fn().mockReturnValue([]) };
    });

    startSyncScheduler();
    await vi.advanceTimersByTimeAsync(60000);

    expect(sql).toMatch(/ORDER BY next_sync ASC/i);
  });

  it('says so when the cap is holding due syncs back', async () => {
    // A held-back config keeps its next_sync and writes no log row, so without
    // this the provider looks healthy while never syncing.
    const configs = [1, 2, 3, 4, 5].map(n => ({ id: n, provider_id: 100 + n, user_id: 1, enabled: 1, next_sync: 0 }));
    const pending = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The warning is rate limited to once every 15 minutes, and that state lives
    // in the module. Let the window elapse with nothing due.
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
    startSyncScheduler();
    await vi.advanceTimersByTimeAsync(900001);
    warn.mockClear();

    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(configs) });
    vi.mocked(syncService.performSync).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    await vi.advanceTimersByTimeAsync(60000);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 due provider sync(s) waiting'));

    warn.mockRestore();
    while (pending.length) pending.shift()({});
    await vi.advanceTimersByTimeAsync(1);
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
