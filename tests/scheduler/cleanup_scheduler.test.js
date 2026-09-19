import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, mockEpg } = vi.hoisted(() => ({
  mockDb: { prepare: vi.fn() },
  mockEpg: { pruneOldEpgData: vi.fn() },
}));

vi.mock('../../src/database/db.js', () => ({ default: mockDb }));
vi.mock('../../src/services/syncService.js', () => ({ performSync: vi.fn() }));
vi.mock('../../src/services/epgService.js', () => ({
  ...mockEpg, updateEpgSource: vi.fn(), updateProviderEpg: vi.fn(),
}));
vi.mock('../../src/services/geoIpUpdateService.js', () => ({ updateGeoIpDatabaseIfNeeded: vi.fn() }));
vi.mock('../../src/database/sqliteWrites.js', async importOriginal => ({
  ...(await importOriginal()),
  deleteInBatches: vi.fn(() => 0),
}));

const { startCleanupScheduler } = await import('../../src/services/schedulerService.js');
const { deleteInBatches } = await import('../../src/database/sqliteWrites.js');

describe('Cleanup Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockDb.prepare.mockReturnValue({ run: vi.fn(), all: vi.fn(() => []), get: vi.fn() });
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // The sweep was hourly with no run at startup, so an instance whose scheduler
  // worker restarts more often than that never ran it at all, and the tables it
  // is supposed to bound grew without limit.
  it('sweeps once shortly after start, not only an hour in', () => {
    startCleanupScheduler();
    expect(mockEpg.pruneOldEpgData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60000);

    expect(mockEpg.pruneOldEpgData).toHaveBeenCalledTimes(1);
    expect(deleteInBatches).toHaveBeenCalledWith(mockDb, 'client_logs', 'timestamp < ?', [expect.any(Number)]);
    expect(deleteInBatches).toHaveBeenCalledWith(mockDb, 'security_logs', 'timestamp < ?', [expect.any(Number)]);
  });

  it('keeps sweeping every hour after that', () => {
    startCleanupScheduler();
    vi.advanceTimersByTime(60000 + 3600000 * 2);

    expect(mockEpg.pruneOldEpgData).toHaveBeenCalledTimes(3);
  });

  it('sweeps the age-bounded log tables in batches, the small ones in one statement', () => {
    startCleanupScheduler();
    vi.advanceTimersByTime(60000);

    const statements = mockDb.prepare.mock.calls.map(call => String(call[0]));
    expect(statements.some(sql => /DELETE FROM blocked_ips/.test(sql))).toBe(true);
    expect(statements.some(sql => /DELETE FROM shared_links/.test(sql))).toBe(true);
    // The growing ones never go through a single unbounded statement.
    expect(statements.some(sql => /DELETE FROM (client|security)_logs/.test(sql))).toBe(false);
  });

  it('survives a sweep that throws', () => {
    vi.mocked(deleteInBatches).mockImplementationOnce(() => { throw new Error('database is locked'); });
    const errors = [];
    vi.spyOn(console, 'error').mockImplementation(m => errors.push(String(m)));

    startCleanupScheduler();
    expect(() => vi.advanceTimersByTime(60000)).not.toThrow();
    expect(errors.some(e => /Cleanup error/.test(e))).toBe(true);

    // And the hourly run still comes.
    vi.advanceTimersByTime(3600000);
    expect(mockEpg.pruneOldEpgData).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
