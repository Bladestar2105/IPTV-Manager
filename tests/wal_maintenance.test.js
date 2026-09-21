import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../src/database/db.js', () => ({ default: { pragma: vi.fn(() => [{ busy: 0, log: 0, checkpointed: 0 }]) } }));
vi.mock('../src/database/epgDb.js', () => ({ default: { pragma: vi.fn(() => [{ busy: 0, log: 0, checkpointed: 0 }]) } }));

const { checkpointDatabase, resolveCheckpointIntervalMs } = await import('../src/services/walMaintenanceService.js');
const { openSqliteConnection } = await import('../src/database/sqliteConnection.js');

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-wal-'));
  dirs.push(dir);
  return join(dir, 'db.sqlite');
}

const walBytes = file => {
  try { return statSync(`${file}-wal`).size; } catch { return 0; }
};

describe('resolveCheckpointIntervalMs', () => {
  it('defaults to five minutes and never goes below 30s', () => {
    expect(resolveCheckpointIntervalMs(undefined)).toBe(300000);
    expect(resolveCheckpointIntervalMs('0')).toBe(300000);
    expect(resolveCheckpointIntervalMs('60000')).toBe(60000);
    expect(resolveCheckpointIntervalMs('1000')).toBe(30000);
  });
});

describe('checkpointDatabase', () => {
  it('keeps the write-ahead log small compared with letting it drift', () => {
    const write = (file, { checkpointEachBatch }) => {
      const db = openSqliteConnection(file);
      try {
        db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, pad TEXT);');
        const insert = db.prepare('INSERT INTO t (pad) VALUES (?)');
        const pad = 'x'.repeat(400);
        for (let batch = 0; batch < 20; batch++) {
          db.transaction(() => { for (let i = 0; i < 500; i++) insert.run(pad); }).immediate();
          if (checkpointEachBatch) {
            const result = checkpointDatabase(db, file, 'test.sqlite');
            expect(result.busy).toBe(false);
          }
        }
        return walBytes(file);
      } finally {
        db.close();
      }
    };

    // Identical write volume; the only difference is the periodic checkpoint the
    // maintenance job performs.
    const maintained = write(tempDb(), { checkpointEachBatch: true });
    const drifting = write(tempDb(), { checkpointEachBatch: false });

    expect(maintained).toBeLessThan(drifting);
  });

  it('reports pending frames with busy=0 without waiting for a reader or preventing writes', () => {
    const file = tempDb();
    const writer = openSqliteConnection(file);
    const reader = openSqliteConnection(file);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let iterator;
    try {
      writer.pragma('wal_autocheckpoint = 0');
      writer.pragma('busy_timeout = 2000');
      writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, pad TEXT);');
      const insert = writer.prepare('INSERT INTO t (pad) VALUES (?)');
      writer.transaction(() => { for (let i = 0; i < 2000; i++) insert.run('y'.repeat(400)); }).immediate();

      iterator = reader.prepare('SELECT id, pad FROM t').iterate();
      iterator.next();                                      // read transaction open
      writer.transaction(() => { for (let i = 0; i < 2000; i++) insert.run('z'.repeat(400)); }).immediate();

      const checkpointStarted = performance.now();
      const result = checkpointDatabase(writer, file, 'test.sqlite');
      expect(performance.now() - checkpointStarted).toBeLessThan(1000);
      expect(result.busy).toBe(false);
      expect(result.log).toBeGreaterThan(result.checkpointed);
      expect(result.checkpointed).toBeGreaterThan(0);
      expect(result.pending).toBe(result.log - result.checkpointed);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(`pending=${result.pending}`));

      const writeStarted = performance.now();
      expect(insert.run('write while the reader is still open').changes).toBe(1);
      expect(performance.now() - writeStarted).toBeLessThan(1000);

      iterator.return();
      iterator = null;
      const completed = checkpointDatabase(writer, file, 'test.sqlite');
      expect(completed.busy).toBe(false);
      expect(completed.log).toBeGreaterThan(0);
      expect(completed.checkpointed).toBe(completed.log);
      expect(completed.pending).toBe(0);
    } finally {
      iterator?.return();
      reader.close();
      writer.close();
    }
  });

  it('checkpoints db.sqlite while a reader holds frames in the separate epg.db file', () => {
    const file = tempDb();
    const epgFile = join(dirname(file), 'epg.db');
    const main = openSqliteConnection(file);
    const epgWriter = openSqliteConnection(epgFile);
    const epgReader = openSqliteConnection(epgFile);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      main.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1)');
      epgWriter.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1)');
      epgReader.exec('BEGIN; SELECT * FROM t');
      epgWriter.exec('INSERT INTO t VALUES (2)');

      const epgResult = checkpointDatabase(epgWriter, epgFile, 'epg.db');
      expect(epgResult.busy).toBe(false);
      expect(epgResult.pending).toBeGreaterThan(0);
      const mainResult = checkpointDatabase(main, file, 'db.sqlite');
      expect(mainResult.busy).toBe(false);
      expect(mainResult.log).toBeGreaterThan(0);
      expect(mainResult.checkpointed).toBe(mainResult.log);
      expect(mainResult.pending).toBe(0);
    } finally {
      epgReader.close();
      epgWriter.close();
      main.close();
    }
  });

  it('does not warn of a backlog when a large allocated WAL is fully checkpointed', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 512 * 1024 * 1024 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const connection = { pragma: () => [{ busy: 0, log: 64, checkpointed: 64 }] };

    const result = checkpointDatabase(connection, 'large.sqlite', 'large.sqlite');

    expect(warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ log: 64, checkpointed: 64, pending: 0 });
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/allocated.*pending=0/));
  });

  it('includes remaining frames in a warning about a large WAL backlog', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 512 * 1024 * 1024 });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = { pragma: () => [{ busy: 0, log: 64, checkpointed: 16 }] };

    const result = checkpointDatabase(connection, 'large.sqlite', 'large.sqlite');

    expect(result).toMatchObject({ busy: false, log: 64, checkpointed: 16, pending: 48 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/512 MB.*log=64.*checkpointed=16.*pending=48/));
  });

  it('reports checkpoint contention and unknown counters without blaming readers', () => {
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 512 * 1024 * 1024 });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connection = { pragma: vi.fn(() => [{ busy: 1, log: -1, checkpointed: -1 }]) };

    const result = checkpointDatabase(connection, 'busy.sqlite', 'busy.sqlite');

    expect(debug.mock.calls.flat().join(' ')).not.toMatch(/readers active/);
    expect(result).toMatchObject({ busy: true, log: -1, checkpointed: -1, pending: null });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/512 MB.*pending=unknown/));
    expect(connection.pragma).toHaveBeenCalledExactlyOnceWith('wal_checkpoint(PASSIVE)');
  });

  it('never throws when the connection refuses the pragma', () => {
    const broken = { pragma: () => { throw new Error('no such pragma'); } };
    expect(() => checkpointDatabase(broken, tempDb(), 'broken')).not.toThrow();
  });
});
