export function migrateMaintenanceQueue(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL, token_version INTEGER NOT NULL,
    type TEXT NOT NULL, target_id INTEGER NOT NULL, user_id INTEGER,
    options TEXT NOT NULL, snapshot TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    available_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
    result TEXT, error TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_active_dedupe
    ON maintenance_jobs(dedupe_key) WHERE status IN ('queued','running');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_one_running
    ON maintenance_jobs(status) WHERE status='running';
  CREATE INDEX IF NOT EXISTS idx_maintenance_ready ON maintenance_jobs(status,available_at,id);`);
}
