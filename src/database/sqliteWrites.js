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
 *
 * Throws when called inside another transaction: better-sqlite3 turns a nested
 * transaction into a SAVEPOINT and discards its BEGIN, so `.immediate` silently
 * becomes the deferred BEGIN of the outer one — precisely the
 * SQLITE_BUSY_SNAPSHOT this helper exists to prevent, and with no sign that it
 * happened. No current caller nests; the guard keeps it that way.
 */
export function immediateTransaction(database, fn) {
  const transaction = database.transaction(fn);
  if (typeof transaction.immediate !== 'function') return transaction;

  return (...args) => {
    if (database.inTransaction) {
      throw new Error('immediateTransaction cannot run inside another transaction: BEGIN IMMEDIATE would be downgraded to a savepoint');
    }
    return transaction.immediate(...args);
  };
}

/**
 * Delete rows in short transactions instead of one long one.
 *
 * A retention sweep is unbounded by nature: it deletes whatever accumulated
 * since it last ran, and it last ran whenever the process that owns it happened
 * to stay up long enough. One `DELETE FROM t WHERE ts < ?` therefore holds the
 * write lock for a length nobody can predict from the code, which is the stall
 * this module exists to avoid — and the sweeps run in a worker that is also
 * pumping streams, where better-sqlite3 blocks the event loop for the duration.
 *
 * `LIMIT` on DELETE needs a compile-time option better-sqlite3 does not
 * guarantee, so the bound goes in a rowid subquery, which every build supports.
 *
 * `table` and `where` are interpolated into SQL: callers pass literals from
 * this repository, never anything derived from input.
 *
 * @param {object} database
 * @param {string} table
 * @param {string} where SQL predicate with `?` placeholders
 * @param {Array} [params] values for the placeholders
 * @param {object} [options]
 * @param {number} [options.batchSize=5000]
 * @param {number} [options.maxBatches=2000] stop rather than loop forever if
 *        something keeps refilling the table faster than this drains it
 * @returns {number} rows removed
 */
export function deleteInBatches(database, table, where, params = [], options = {}) {
  const batchSize = Number(options.batchSize) > 0 ? Math.floor(Number(options.batchSize)) : 5000;
  const maxBatches = Number(options.maxBatches) > 0 ? Math.floor(Number(options.maxBatches)) : 2000;
  const statement = database.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`);
  // Built once, not once per batch: database.transaction() compiles its own
  // BEGIN/COMMIT/ROLLBACK every time it is called, and the whole point here is
  // to run many batches.
  const removeBatch = immediateTransaction(database, () => statement.run(...params, batchSize).changes);

  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const changes = removeBatch();
    removed += changes;
    if (changes < batchSize) break;
  }
  return removed;
}

// Deliberately NOT unref'd. This timer sits inside an operation the caller is
// awaiting, not in a background schedule: an unref'd one lets Node exit with the
// retry still pending, so the write is silently dropped and the awaited promise
// never settles (`Detected unsettled top-level await`, exit code 13). That is
// the whole failure this helper exists to prevent, arriving by another route —
// it bites a worker finishing an in-flight write after its server closed, and
// any one-shot script that imports these helpers.
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

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
