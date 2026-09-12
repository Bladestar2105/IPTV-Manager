export function migrateAiSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ai_connections (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_preferences (owner_key TEXT PRIMARY KEY, data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_jobs (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER, feature TEXT NOT NULL, connection_id TEXT, connection_version INTEGER, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, error_code TEXT, idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, request_started_at INTEGER, UNIQUE(owner_key,idempotency_key));
        CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, connection_id TEXT NOT NULL, feature TEXT NOT NULL, model TEXT, status TEXT NOT NULL, prompt_tokens INTEGER, completion_tokens INTEGER, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_proposals (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL, change_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_changes (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_rules (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER NOT NULL, data_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_enrichments (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, user_id INTEGER NOT NULL, provider_channel_id INTEGER NOT NULL, source_hash TEXT NOT NULL, language TEXT NOT NULL, feature TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_sync_snapshots (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider_id INTEGER NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_codex_credentials (owner_key TEXT NOT NULL, connection_id TEXT NOT NULL, encrypted_blob TEXT NOT NULL, account_hash TEXT, account_label TEXT, plan_type TEXT, auth_method TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_key, connection_id));
        CREATE TABLE IF NOT EXISTS ai_codex_logins (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, connection_id TEXT NOT NULL, login_id TEXT, status TEXT NOT NULL, verification_url TEXT, user_code TEXT, actor_version INTEGER, session_hash TEXT NOT NULL, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_codex_runtimes (owner_key TEXT NOT NULL, connection_id TEXT NOT NULL, lease_id TEXT NOT NULL, worker_pid INTEGER NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_key, connection_id));
        CREATE INDEX IF NOT EXISTS idx_ai_connections_owner ON ai_connections(owner_key, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_jobs_owner ON ai_jobs(owner_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_jobs_active ON ai_jobs(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_owner ON ai_usage(owner_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage(created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_usage_connection ON ai_usage(connection_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_proposals_owner ON ai_proposals(owner_key, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_changes_owner ON ai_changes(owner_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner ON ai_conversations(owner_key, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_rules_owner ON ai_rules(owner_key, updated_at);
        CREATE INDEX IF NOT EXISTS idx_ai_enrichments_owner ON ai_enrichments(owner_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_sync_snapshots_user ON ai_sync_snapshots(user_id, provider_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_codex_logins_owner ON ai_codex_logins(owner_key, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_codex_logins_state ON ai_codex_logins(status, expires_at);
    `);
    // One manager-side link per reliably reported external ChatGPT identity, so a
    // second connection cannot multiply a personal plan's quota.
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_codex_account ON ai_codex_credentials(account_hash) WHERE account_hash IS NOT NULL");
    if(!db.prepare('PRAGMA table_info(ai_usage)').all().some(column=>column.name==='error_code')) db.exec('ALTER TABLE ai_usage ADD COLUMN error_code TEXT');
    // Providers have different request deadlines, so a crashed worker's reservation
    // expires on its own recorded deadline instead of one global timeout.
    if(!db.prepare('PRAGMA table_info(ai_usage)').all().some(column=>column.name==='expires_at')) db.exec('ALTER TABLE ai_usage ADD COLUMN expires_at INTEGER');
    // Last poll by the session that started a sign-in. A completion is only
    // adopted while that session is still watching its own attempt.
    if(!db.prepare('PRAGMA table_info(ai_codex_logins)').all().some(column=>column.name==='last_seen_at')) db.exec('ALTER TABLE ai_codex_logins ADD COLUMN last_seen_at INTEGER');
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS ai_delete_user AFTER DELETE ON users BEGIN
            DELETE FROM ai_connections WHERE owner_key='user:' || OLD.id;
            DELETE FROM ai_preferences WHERE owner_key='user:' || OLD.id;
            DELETE FROM ai_usage WHERE owner_key='user:' || OLD.id;
            DELETE FROM ai_jobs WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_proposals WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_changes WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_conversations WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_rules WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_enrichments WHERE owner_key='user:' || OLD.id OR user_id=OLD.id;
            DELETE FROM ai_sync_snapshots WHERE user_id=OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS ai_delete_admin AFTER DELETE ON admin_users BEGIN
            DELETE FROM ai_connections WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_preferences WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_usage WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_jobs WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_proposals WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_changes WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_conversations WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_rules WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_enrichments WHERE owner_key='admin:' || OLD.id;
        END;
    `);
    // Additive personal ChatGPT runtime cleanup. Kept separate from the triggers
    // above so an upgrade never rewrites existing deletion behavior. On-disk
    // runtime directories are removed by the application sweep, which treats a
    // directory without a credential row as orphaned.
    db.exec(`
        CREATE TRIGGER IF NOT EXISTS ai_codex_delete_user AFTER DELETE ON users BEGIN
            DELETE FROM ai_codex_credentials WHERE owner_key='user:' || OLD.id;
            DELETE FROM ai_codex_logins WHERE owner_key='user:' || OLD.id;
            DELETE FROM ai_codex_runtimes WHERE owner_key='user:' || OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS ai_codex_delete_admin AFTER DELETE ON admin_users BEGIN
            DELETE FROM ai_codex_credentials WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_codex_logins WHERE owner_key='admin:' || OLD.id;
            DELETE FROM ai_codex_runtimes WHERE owner_key='admin:' || OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS ai_codex_delete_connection AFTER DELETE ON ai_connections BEGIN
            DELETE FROM ai_codex_credentials WHERE owner_key=OLD.owner_key AND connection_id=OLD.id;
            DELETE FROM ai_codex_logins WHERE owner_key=OLD.owner_key AND connection_id=OLD.id;
            DELETE FROM ai_codex_runtimes WHERE owner_key=OLD.owner_key AND connection_id=OLD.id;
        END;
    `);
}
