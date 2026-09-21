import fs from 'fs';
import db, { DB_PATH } from '../database/db.js';
import epgDb from '../database/epgDb.js';
import { EPG_DB_PATH } from '../config/constants.js';
import { resolveBudget } from '../utils/env.js';

// SQLite only auto-checkpoints at the end of a write transaction, and a passive
// checkpoint can never reclaim frames that an active reader still needs. With a
// dozen workers constantly reading, the write-ahead log can therefore keep
// growing until it dwarfs the database itself — the affected deployment reached
// a 6.27 GB WAL next to a 4.83 GB database.
//
// A periodic PASSIVE checkpoint gives SQLite a chance to drain the log outside
// the write path. PASSIVE never waits for a reader, so it cannot stall a worker
// the way TRUNCATE or RESTART would. A checkpointed log can remain allocated;
// journal_size_limit lets SQLite shrink it when a later writer can restart the
// log after readers release their snapshots.
const DEFAULT_INTERVAL_MS = 300000;
const MIN_INTERVAL_MS = 30000;
const WARN_WAL_BYTES = 512 * 1024 * 1024;

export function resolveCheckpointIntervalMs(raw = process.env.SQLITE_CHECKPOINT_INTERVAL_MS) {
  return resolveBudget(raw, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS,
    Number.MAX_SAFE_INTEGER, 'SQLITE_CHECKPOINT_INTERVAL_MS');
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
    const log = result?.log ?? -1;
    const checkpointed = result?.checkpointed ?? -1;
    // SQLite reports -1 when frame counts are unavailable. busy=0 alone does
    // not mean PASSIVE checkpointed all frames: readers or writers may remain.
    const pending = log >= 0 && checkpointed >= 0 ? Math.max(0, log - checkpointed) : null;
    const frames = `log=${log}, checkpointed=${checkpointed}, pending=${pending ?? 'unknown'} frames`;
    if (result?.busy) {
      console.debug(`WAL checkpoint for ${label} could not run (checkpoint lock busy); wal=${after} bytes; ${frames}`);
    } else if (pending > 0 || before !== after) {
      console.debug(`WAL checkpoint for ${label}: ${before} -> ${after} bytes; ${frames}`);
    }
    if (after >= WARN_WAL_BYTES) {
      const allocation = `${label} write-ahead log has ${Math.round(after / 1048576)} MB allocated; ${frames}`;
      if (pending === 0) {
        console.debug(`${allocation}; all frames checkpointed, allocation can be reused`);
      } else {
        console.warn(`⚠️ ${allocation}`);
      }
    }
    return { before, after, busy: Boolean(result?.busy), log, checkpointed, pending };
  } catch (e) {
    console.warn(`WAL checkpoint for ${label} failed: ${e.message}`);
    return { before, after: before, busy: true, error: e.message };
  }
}

/**
 * Start the periodic checkpoint.
 *
 * Only the primary calls this. A checkpoint is synchronous and can copy a large
 * WAL, so running it in a worker would stall the streams that worker is pumping;
 * the primary serves no traffic. One checkpoint per interval covers every
 * worker, because they all share the same files.
 */
export function startWalMaintenance() {
  const intervalMs = resolveCheckpointIntervalMs();

  const run = () => {
    // DB_PATH rather than a second copy of the join: this reads the -wal file
    // beside it, so a renamed database would silently report 0 bytes forever
    // and the size warning below would never fire again.
    checkpointDatabase(db, DB_PATH, 'db.sqlite');
    checkpointDatabase(epgDb, EPG_DB_PATH, 'epg.db');
  };

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.info(`🧾 WAL maintenance started (every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
