import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, mockEpg, state } = vi.hoisted(() => ({
  mockDb: { prepare: vi.fn() },
  mockEpg: {
    updateEpgSource: vi.fn(),
    updateProviderEpg: vi.fn(),
  },
  state: { sources: [], providers: [] },
}));

vi.mock('../../src/database/db.js', () => ({ default: mockDb }));
vi.mock('../../src/services/syncService.js', () => ({ performSync: vi.fn() }));
vi.mock('../../src/services/epgService.js', () => ({
  ...mockEpg,
  pruneOldEpgData: vi.fn(),
}));
vi.mock('../../src/services/geoIpUpdateService.js', () => ({
  updateGeoIpDatabaseIfNeeded: vi.fn(),
}));
vi.mock('../../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn().mockResolvedValue(true),
}));

import { startEpgScheduler } from '../../src/services/schedulerService.js';

describe('EPG Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockEpg.updateEpgSource.mockReset();
    mockEpg.updateProviderEpg.mockReset();
    state.sources = [];
    state.providers = [];
    mockDb.prepare.mockImplementation((sql) => ({
      all: vi.fn(() => sql.includes('epg_sources') ? state.sources : state.providers),
      get: vi.fn(),
      run: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps only one EPG interval when started twice', async () => {
    state.sources = [{ id: 1, last_update: 0, update_interval: 1 }];
    mockEpg.updateEpgSource.mockResolvedValue(undefined);

    startEpgScheduler();
    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(1);
  });

  it('does not overlap a source and releases it after success', async () => {
    state.sources = [{ id: 7, last_update: 0, update_interval: 1 }];
    let resolveUpdate;
    mockEpg.updateEpgSource.mockReturnValueOnce(new Promise(resolve => {
      resolveUpdate = resolve;
    }));

    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(1);

    resolveUpdate();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(2);
  });

  it('releases a source after a failed update', async () => {
    state.sources = [{ id: 8, last_update: 0, update_interval: 1 }];
    mockEpg.updateEpgSource
      .mockRejectedValueOnce(new Error('EPG failed'))
      .mockResolvedValueOnce(undefined);

    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(2);
  });
});
