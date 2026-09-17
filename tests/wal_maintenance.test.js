import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/database/db.js', () => ({ default: { pragma: vi.fn(() => [{ busy: 0, log: 0, checkpointed: 0 }]) } }));
vi.mock('../src/database/epgDb.js', () => ({ default: { pragma: vi.fn(() => [{ busy: 0, log: 0, checkpointed: 0 }]) } }));

const { checkpointDatabase, resolveCheckpointIntervalMs } = await import('../src/services/walMaintenanceService.js');
const { openSqliteConnection } = await import('../src/database/sqliteConnection.js');

const dirs = [];
afterEach(() => {
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

  it('reports a checkpoint that a reader is blocking instead of throwing', () => {
    const file = tempDb();
    const writer = openSqliteConnection(file);
    const reader = openSqliteConnection(file);
    try {
      writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, pad TEXT);');
      const insert = writer.prepare('INSERT INTO t (pad) VALUES (?)');
      writer.transaction(() => { for (let i = 0; i < 2000; i++) insert.run('y'.repeat(400)); }).immediate();

      const iterator = reader.prepare('SELECT id, pad FROM t').iterate();
      iterator.next();                                      // read transaction open
      writer.transaction(() => { for (let i = 0; i < 2000; i++) insert.run('z'.repeat(400)); }).immediate();

      const result = checkpointDatabase(writer, file, 'test.sqlite');
      expect(result).toHaveProperty('after');
      expect(typeof result.busy).toBe('boolean');

      iterator.return();
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('never throws when the connection refuses the pragma', () => {
    const broken = { pragma: () => { throw new Error('no such pragma'); } };
    expect(() => checkpointDatabase(broken, tempDb(), 'broken')).not.toThrow();
  });
});
