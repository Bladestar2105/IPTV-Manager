// better-sqlite3's `db.transaction(fn)` emits a plain `BEGIN`, which is
// deferred: the transaction takes a read snapshot at its first SELECT and only
// asks for the write lock later. If another connection commits in between,
// SQLite answers SQLITE_BUSY_SNAPSHOT — reported as "database is locked" and
// *not* covered by busy_timeout, because there is nothing to wait for.
//
// Every transaction that reads before it writes should therefore start with
// BEGIN IMMEDIATE.

const RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

export function isRetryableSqliteError(error) {
  return Boolean(error) && RETRYABLE_CODES.has(error.code);
}

/**
 * Wrap `fn` in a BEGIN IMMEDIATE transaction.
 *
 * Falls back to the plain transaction when the connection does not expose the
 * mode (test doubles), so callers never have to branch.
 */
export function immediateTransaction(database, fn) {
  const transaction = database.transaction(fn);
  if (typeof transaction.immediate === 'function') {
    return (...args) => transaction.immediate(...args);
  }
  return transaction;
}

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

/**
 * Run a short, repeatable write with a bounded retry.
 *
 * Only for operations that can simply be executed again: the whole read state
 * has to be rebuilt inside `operation`, and partial work must be rolled back by
 * the transaction. Long catalog transactions are deliberately not retried here
 * — re-running them would mean fetching and rebuilding everything.
 */
export async function runWriteWithRetry(operation, options = {}) {
  const attempts = Number(options.attempts) > 0 ? Number(options.attempts) : 3;
  const baseDelayMs = Number(options.baseDelayMs) >= 0 ? Number(options.baseDelayMs) : 50;
  const label = options.label || 'write';

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryableSqliteError(error)) throw error;
      console.debug(`Retrying ${label} after ${error.code} (attempt ${attempt}/${attempts})`);
      if (baseDelayMs > 0) await delay(baseDelayMs * attempt);
    }
  }
}

/**
 * `message [CODE]` for SQLite errors, plain message otherwise.
 *
 * Logging only `e.message` made "database is locked" indistinguishable between
 * SQLITE_BUSY (a writer that waited out its busy_timeout) and
 * SQLITE_BUSY_SNAPSHOT (a deferred transaction whose snapshot went stale) —
 * two problems with completely different fixes.
 */
export function formatDbError(error) {
  if (!error) return 'unknown error';
  const message = error.message || String(error);
  return error.code ? `${message} [${error.code}]` : message;
}
