// Schema of the cross-process lock table, in one place.
//
// Both initDb and providerLockService need it: the service must not depend on
// startup order, and startup must not depend on the service (which imports the
// shared connection). Keeping two copies of the DDL meant keeping two copies of
// a migration, which is how the first one came to be neither atomic nor safe
// against two workers running it at once.

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS provider_locks (
    lock_key TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

const COLUMNS = '(lock_key, operation, owner_pid, owner_token, acquired_at, expires_at)';

const hasTable = (database, name) => Boolean(
  database.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
);

/**
 * Create the table, migrating the shape that keyed it by provider_id.
 *
 * The rows are leases another process may still hold — the cross-process guard
 * is the whole point of the table — so they are carried over rather than
 * dropped. Dropping them would let this instance take a lock somebody else is
 * holding, which is exactly the double-run the table prevents.
 *
 * Runs as one BEGIN IMMEDIATE transaction. A multi-statement `exec` is not
 * transactional, so an interrupted run used to leave the database holding only
 * `provider_locks_v2`; the next start then created an empty `provider_locks`,
 * saw the new shape and skipped the migration, stranding the leases in an
 * orphan table forever. Two workers racing it produced the same result without
 * any crash. The transaction also serializes them: the loser re-reads the shape
 * inside its own transaction and finds nothing left to do.
 *
 * @returns {number} leases carried over
 */
export function migrateProviderLockTable(database) {
  if (typeof database.pragma !== 'function' || typeof database.transaction !== 'function') {
    database.exec(CREATE_TABLE);
    return 0;
  }

  const migrate = database.transaction(() => {
    let carried = 0;

    // Recovery for a database left behind by the earlier non-atomic migration.
    if (hasTable(database, 'provider_locks_v2')) {
      if (hasTable(database, 'provider_locks')) {
        database.exec(`INSERT OR IGNORE INTO provider_locks ${COLUMNS}
                       SELECT lock_key, operation, owner_pid, owner_token, acquired_at, expires_at
                       FROM provider_locks_v2;`);
        carried += database.prepare('SELECT COUNT(*) AS c FROM provider_locks_v2').get().c;
        database.exec('DROP TABLE provider_locks_v2;');
      } else {
        database.exec('ALTER TABLE provider_locks_v2 RENAME TO provider_locks;');
        carried += database.prepare('SELECT COUNT(*) AS c FROM provider_locks').get().c;
      }
    }

    const columns = database.pragma('table_info(provider_locks)') || [];
    const needsMigration = columns.length > 0 && !columns.some(column => column.name === 'lock_key');
    if (needsMigration) {
      database.exec(`CREATE TABLE provider_locks_v2 (
          lock_key TEXT PRIMARY KEY, operation TEXT NOT NULL, owner_pid INTEGER NOT NULL,
          owner_token TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        INSERT OR IGNORE INTO provider_locks_v2 ${COLUMNS}
          SELECT 'provider:' || provider_id, operation, owner_pid, owner_token, acquired_at, expires_at
          FROM provider_locks;
        DROP TABLE provider_locks;
        ALTER TABLE provider_locks_v2 RENAME TO provider_locks;`);
      carried += database.prepare('SELECT COUNT(*) AS c FROM provider_locks').get().c;
    }

    database.exec(CREATE_TABLE);
    return carried;
  });

  return typeof migrate.immediate === 'function' ? migrate.immediate() : migrate();
}

/**
 * Drop only leases whose lease has run out.
 *
 * Another process may still be using the same DATA_DIR — an overlapping
 * restart, or a second instance — and the lock is explicitly cross-process, so
 * a blanket delete would hand that process's work to this one. A lock left
 * behind by a killed process disappears on its own once its lease expires;
 * owner_pid is not usable for liveness because PIDs are namespaced per
 * container and get reused.
 *
 * @returns {number} leases removed
 */
export function sweepExpiredProviderLocks(database, now = Math.floor(Date.now() / 1000)) {
  return database.prepare('DELETE FROM provider_locks WHERE expires_at <= ?').run(now).changes;
}
