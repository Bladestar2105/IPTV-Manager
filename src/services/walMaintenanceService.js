import fs from 'fs';
import path from 'path';
import db from '../database/db.js';
import epgDb from '../database/epgDb.js';
import { DATA_DIR, EPG_DB_PATH } from '../config/constants.js';

// SQLite only auto-checkpoints at the end of a write transaction, and a passive
// checkpoint can never reclaim frames that an active reader still needs. With a
// dozen workers constantly reading, the write-ahead log can therefore keep
// growing until it dwarfs the database itself — the affected deployment reached
// a 6.27 GB WAL next to a 4.83 GB database.
//
// A periodic PASSIVE checkpoint gives SQLite a chance to drain the log outside
// the write path. PASSIVE never waits for a reader, so it cannot stall a worker
// the way TRUNCATE or RESTART would. A drained log is reused in place; the
// journal_size_limit set on every connection makes SQLite shrink the file on the
// next commit, so the size drop follows one write later.
const DEFAULT_INTERVAL_MS = 300000;
const MIN_INTERVAL_MS = 30000;
const WARN_WAL_BYTES = 512 * 1024 * 1024;

export function resolveCheckpointIntervalMs(raw = process.env.SQLITE_CHECKPOINT_INTERVAL_MS) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(parsed, MIN_INTERVAL_MS);
}

function walSize(dbPath) {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

export function checkpointDatabase(connection, dbPath, label) {
  const before = walSize(dbPath);
  try {
    const [result] = connection.pragma('wal_checkpoint(PASSIVE)');
    const after = walSize(dbPath);
    if (result?.busy) {
      console.debug(`WAL checkpoint for ${label} could not complete (readers active); wal=${after} bytes`);
    } else if (before !== after) {
      console.debug(`WAL checkpoint for ${label}: ${before} -> ${after} bytes`);
    }
    if (after >= WARN_WAL_BYTES) {
      console.warn(`⚠️ ${label} write-ahead log is ${Math.round(after / 1048576)} MB; checkpoints are not draining it`);
    }
    return { before, after, busy: Boolean(result?.busy) };
  } catch (e) {
    console.warn(`WAL checkpoint for ${label} failed: ${e.message}`);
    return { before, after: before, busy: true, error: e.message };
  }
}

/**
 * Start the periodic checkpoint. Only the scheduler worker calls this; one
 * checkpoint per interval is enough for all workers, they share the files.
 */
export function startWalMaintenance() {
  const intervalMs = resolveCheckpointIntervalMs();
  const mainPath = path.join(DATA_DIR, 'db.sqlite');

  const run = () => {
    checkpointDatabase(db, mainPath, 'db.sqlite');
    checkpointDatabase(epgDb, EPG_DB_PATH, 'epg.db');
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.info(`🧾 WAL maintenance started (every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
