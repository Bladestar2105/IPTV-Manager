import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', async importOriginal => ({ ...(await importOriginal()), fetchSafe: vi.fn() }));
vi.mock('@iptv/xtream-api', () => ({ Xtream: class {} }));

const { reportCatalogWriteDuration } = await import('../src/services/syncService.js');

// Applying a catalog has to be atomic — half a catalog is worse than none — so
// it is the longest write lock the application takes. Every other connection
// that wants to write during it waits out its busy_timeout and then reports
// "database is locked". The operator saw the symptom in one worker and the
// cause in another, minutes apart, with nothing naming either.

let warnings;
let infos;

beforeEach(() => {
  warnings = [];
  infos = [];
  vi.spyOn(console, 'warn').mockImplementation(m => warnings.push(String(m)));
  vi.spyOn(console, 'info').mockImplementation(m => infos.push(String(m)));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('reportCatalogWriteDuration', () => {
  it('names the cause when the lock was held past the timeout everyone else waits', () => {
    reportCatalogWriteDuration(7, 45000);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provider 7');
    expect(warnings[0]).toContain('45000ms');
    expect(warnings[0]).toContain('SQLITE_BUSY_TIMEOUT_MS (30000ms)');
    expect(warnings[0]).toContain('database is locked');
  });

  it('mentions a run that is getting close, without calling it a problem', () => {
    reportCatalogWriteDuration(7, 20000);

    expect(warnings).toEqual([]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('20000ms');
  });

  it('says nothing about a run that finished comfortably', () => {
    reportCatalogWriteDuration(7, 1200);

    expect(warnings).toEqual([]);
    expect(infos).toEqual([]);
  });

  it('measures against the configured timeout, not the default', () => {
    vi.stubEnv('SQLITE_BUSY_TIMEOUT_MS', '120000');

    reportCatalogWriteDuration(7, 45000);
    expect(warnings).toEqual([]);

    reportCatalogWriteDuration(7, 130000);
    expect(warnings[0]).toContain('SQLITE_BUSY_TIMEOUT_MS (120000ms)');
  });
});
