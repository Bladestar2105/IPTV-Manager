import Database from 'better-sqlite3';
import { resolveBudget } from '../utils/env.js';

// Every SQLite connection in the process has to agree on how long a statement
// waits for a lock. `new Database(path)` without an explicit timeout leaves
// busy_timeout at 0, so such a connection reports "database is locked" on the
// very first collision instead of waiting for the current writer.
const DEFAULT_BUSY_TIMEOUT_MS = 30000;
const MIN_BUSY_TIMEOUT_MS = 1000;
const MAX_BUSY_TIMEOUT_MS = 300000;

// A checkpointed WAL is reused in place and never shrinks on its own, so a
// single large import can leave the file permanently oversized. The limit lets
// SQLite truncate it back down as soon as a checkpoint has drained it.
const DEFAULT_JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;
const MIN_JOURNAL_SIZE_LIMIT = 1024 * 1024;

/**
 * Lock wait used by every connection of this process, in milliseconds.
 * Must stay above the longest write transaction the application performs.
 */
export function resolveBusyTimeoutMs(raw = process.env.SQLITE_BUSY_TIMEOUT_MS) {
  return resolveBudget(raw, DEFAULT_BUSY_TIMEOUT_MS, MIN_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS, 'SQLITE_BUSY_TIMEOUT_MS');
}

// better-sqlite3 is synchronous and its busy handler sleeps on the main thread,
// so the wait blocks the whole worker — every live stream it is pumping
// included. Latency-critical bookkeeping therefore gives up quickly instead:
// losing one activity update is cheaper than stalling playback.
const DEFAULT_LATENCY_BUSY_TIMEOUT_MS = 250;

export function resolveLatencyBusyTimeoutMs(raw = process.env.SQLITE_LATENCY_BUSY_TIMEOUT_MS) {
  const resolved = resolveBudget(raw, DEFAULT_LATENCY_BUSY_TIMEOUT_MS, 10, MAX_BUSY_TIMEOUT_MS, 'SQLITE_LATENCY_BUSY_TIMEOUT_MS');
  // Never longer than the general wait, whatever the operator configured.
  return Math.min(resolved, resolveBusyTimeoutMs());
}

/** Upper bound for the WAL file after a checkpoint, in bytes. */
export function resolveJournalSizeLimit(raw = process.env.SQLITE_WAL_SIZE_LIMIT_BYTES) {
  return resolveBudget(raw, DEFAULT_JOURNAL_SIZE_LIMIT, MIN_JOURNAL_SIZE_LIMIT, Number.MAX_SAFE_INTEGER, 'SQLITE_WAL_SIZE_LIMIT_BYTES');
}

/**
 * Open a SQLite connection with the settings shared by the whole application.
 *
 * @param {string} filePath database file
 * @param {object} [options]
 * @param {boolean} [options.readonly=false] open read-only and skip write pragmas
 * @param {boolean} [options.foreignKeys=true] enforce foreign keys on this connection
 * @param {boolean} [options.walMode=true] ensure WAL journal mode and the size limit
 * @param {boolean} [options.latency=false] this connection serves a latency
 *        critical path: give up on a lock quickly instead of blocking the
 *        worker's event loop for the batch timeout
 */
export function openSqliteConnection(filePath, options = {}) {
  const { readonly = false, foreignKeys = true, walMode = true, fileMustExist = false, latency = false } = options;
  const busyTimeout = latency ? resolveLatencyBusyTimeoutMs() : resolveBusyTimeoutMs();

  const connection = new Database(filePath, { readonly, fileMustExist, timeout: busyTimeout });
  connection.pragma(`busy_timeout = ${busyTimeout}`);
  connection.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);

  if (!readonly) {
    connection.pragma('synchronous = NORMAL');
    if (walMode) {
      connection.pragma('journal_mode = WAL');
      connection.pragma(`journal_size_limit = ${resolveJournalSizeLimit()}`);
    }
  }

  return connection;
}
