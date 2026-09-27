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
vi.mock('../../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
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

  it('backs off a failed custom source for fifteen minutes, then resumes updates', async () => {
    state.sources = [{ id: 8, last_update: 0, update_interval: 1 }];
    mockEpg.updateEpgSource
      .mockRejectedValueOnce(new Error('EPG failed'))
      .mockResolvedValueOnce(undefined);

    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(14 * 60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockEpg.updateEpgSource).toHaveBeenCalledTimes(3);
  });

  it.each(['custom', 'provider'])('starts the %s cooldown when a slow attempt fails, not when it starts', async type => {
    const update = type === 'custom' ? mockEpg.updateEpgSource : mockEpg.updateProviderEpg;
    if (type === 'custom') state.sources = [{ id: 8, last_update: 0, update_interval: 1 }];
    else state.providers = [{ id: 8, last_epg_update: 0, epg_update_interval: 1 }];
    let rejectUpdate;
    update.mockReturnValueOnce(new Promise((resolve, reject) => { rejectUpdate = reject; }));
    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(20 * 60000);
    expect(update).toHaveBeenCalledTimes(1);

    rejectUpdate(new Error('HTTP 429'));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(14 * 60000);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(['custom', 'provider'])('does not let a failed %s block another source type with the same ID', async type => {
    state.sources = [{ id: 8, last_update: 0, update_interval: 1 }];
    state.providers = [{ id: 8, last_epg_update: 0, epg_update_interval: 1 }];
    const failed = type === 'custom' ? mockEpg.updateEpgSource : mockEpg.updateProviderEpg;
    const healthy = type === 'custom' ? mockEpg.updateProviderEpg : mockEpg.updateEpgSource;
    failed.mockRejectedValue(new Error('HTTP 403'));
    healthy.mockResolvedValue(undefined);

    startEpgScheduler();
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(60000);

    expect(failed).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});
