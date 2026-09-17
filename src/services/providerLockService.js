import { randomUUID } from 'crypto';
import db from '../database/db.js';

// A provider sync runs for minutes. The lock outlives a slow run but expires
// soon enough that a crashed worker does not block the provider for hours; a
// held lock is renewed while the work is still in progress.
const DEFAULT_TTL_SECONDS = 900;
const RENEW_INTERVAL_MS = 60000;

// 'ready'       the table exists and locks work
// 'unsupported' this connection is not a usable SQLite database (test doubles)
// 'unknown'     not probed yet, or the last probe failed transiently
let tableState = 'unknown';

/**
 * The lock table is infrastructure for this service, so it is created here as
 * well as in initDb. Creation is idempotent.
 *
 * A failing probe is never silently permanent. Only a connection that cannot be
 * a SQLite database at all — no `exec`/`prepare`, or an error without a SQLite
 * code, i.e. a test double — is remembered as unsupported. A real database that
 * refuses the statement (`SQLITE_BUSY` while another writer holds the lock,
 * `SQLITE_READONLY`, …) returns 'busy' without caching, so the caller fails
 * closed and the next call probes again.
 *
 * @returns {'ready'|'unsupported'|'busy'}
 */
function ensureTable() {
  if (tableState === 'ready' || tableState === 'unsupported') return tableState;

  if (typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    tableState = 'unsupported';
    console.warn('Provider locks unavailable: this database cannot hold the lock table');
    return tableState;
  }

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_locks (
        provider_id INTEGER PRIMARY KEY,
        operation TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    tableState = 'ready';
    return tableState;
  } catch (e) {
    if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_')) {
      // A real database said no. Do not cache: the next attempt probes again.
      console.warn(`Provider lock table unavailable right now: ${e.message} [${e.code}]`);
      return 'busy';
    }
    tableState = 'unsupported';
    console.warn('Provider locks unavailable, concurrent provider operations are not serialized:', e.message);
    return tableState;
  }
}

/** Test seam: forget the cached probe result. */
export function resetProviderLockState() {
  tableState = 'unknown';
}

/**
 * Try to become the single owner of `providerId` for `operation`.
 *
 * schedulerService kept a per-process `Set`, which cannot see a manual sync
 * running in another cluster worker, and provider deletion had no guard at all.
 * The lock lives in the database so it spans workers and processes.
 *
 * Fails closed: null means the caller must not proceed — either somebody else
 * holds the lock, or the lock could not be taken because of contention. The only
 * degraded result is a database that cannot hold the table at all (fixtures and
 * test doubles), which is decided once in ensureTable().
 *
 * @returns {{providerId:number, operation:string, token:string, release:Function}|null}
 */
export function acquireProviderLock(providerId, operation, options = {}) {
  const ttlSeconds = Number(options.ttlSeconds) > 0 ? Number(options.ttlSeconds) : DEFAULT_TTL_SECONDS;
  const state = ensureTable();
  // A database that refused the probe is contended, not unsupported: fail closed.
  if (state === 'busy') return null;
  if (state === 'unsupported') return { providerId, operation, token: null, degraded: true, release() {} };

  const now = Math.floor(Date.now() / 1000);
  const token = randomUUID();
  try {
    db.prepare('DELETE FROM provider_locks WHERE provider_id = ? AND expires_at <= ?').run(providerId, now);
    const inserted = db.prepare(`
      INSERT INTO provider_locks (provider_id, operation, owner_pid, owner_token, acquired_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO NOTHING
    `).run(providerId, operation, process.pid, token, now, now + ttlSeconds).changes;
    if (inserted !== 1) return null;
  } catch (e) {
    // Fail closed. Reaching this point means ensureTable() succeeded, so the
    // table exists and the failure is real contention — SQLITE_BUSY here is
    // precisely the situation the lock exists for. Handing out a no-op lock
    // would allow exactly the overlapping operation it has to prevent.
    console.warn(`Could not acquire provider lock ${providerId}/${operation}: ${e.message} [${e.code || 'Error'}]`);
    return null;
  }

  const renew = setInterval(() => {
    try {
      db.prepare('UPDATE provider_locks SET expires_at = ? WHERE provider_id = ? AND owner_token = ?')
        .run(Math.floor(Date.now() / 1000) + ttlSeconds, providerId, token);
    } catch { /* the release below clears it anyway */ }
  }, RENEW_INTERVAL_MS);
  renew.unref?.();

  return {
    providerId,
    operation,
    token,
    degraded: false,
    release() {
      clearInterval(renew);
      try {
        db.prepare('DELETE FROM provider_locks WHERE provider_id = ? AND owner_token = ?').run(providerId, token);
      } catch (e) {
        console.warn(`Could not release provider lock ${providerId}:`, e.message);
      }
    },
  };
}

/**
 * Wording for a refused operation. A lock that no longer has a holder row means
 * the acquisition itself failed (contention), not that somebody owns it.
 */
export function describeLockConflict(providerId, fallbackOperation = 'processed') {
  const holder = describeProviderLock(providerId);
  if (!holder) {
    return `Provider ${providerId} could not be locked because the database is busy; try again shortly`;
  }
  const what = holder.operation === 'delete' ? 'deleted' : 'synchronized';
  return `Provider ${providerId} is already being ${what || fallbackOperation}`;
}

export function releaseProviderLock(lock) {
  if (lock && typeof lock.release === 'function') lock.release();
}

/** Who currently holds the lock, for diagnostics and 409 responses. */
export function describeProviderLock(providerId) {
  if (ensureTable() !== 'ready') return null;
  try {
    return db.prepare('SELECT operation, owner_pid, acquired_at, expires_at FROM provider_locks WHERE provider_id = ?')
      .get(providerId) || null;
  } catch {
    return null;
  }
}

/**
 * Drop every lock. Only the primary calls this, before any worker is forked, so
 * a lock left behind by a killed container never blocks the next start.
 */
export function clearProviderLocks() {
  if (ensureTable() !== 'ready') return 0;
  try {
    return db.prepare('DELETE FROM provider_locks').run().changes;
  } catch {
    return 0;
  }
}

/**
 * Startup recovery: drop only locks whose lease has run out.
 *
 * Another process may still be using the same DATA_DIR — an overlapping restart,
 * or a second instance — and the lock is explicitly cross-process, so a blanket
 * delete would hand that process's providers to this one. A lock left behind by
 * a killed process disappears on its own once its lease expires
 * (DEFAULT_TTL_SECONDS); owner_pid is not usable for liveness because PIDs are
 * namespaced per container and get reused.
 */
export function clearExpiredProviderLocks(now = Math.floor(Date.now() / 1000)) {
  if (ensureTable() !== 'ready') return 0;
  try {
    return db.prepare('DELETE FROM provider_locks WHERE expires_at <= ?').run(now).changes;
  } catch (e) {
    console.warn('Could not sweep expired provider locks:', e.message);
    return 0;
  }
}
