import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The personal ChatGPT adapter is exercised against a synthetic app server that
// speaks the real newline-delimited JSON-RPC protocol, so the manager's own
// client, runtime lease, credential store and provider adapter run unmodified.
// Only the operating-system sandbox is replaced by a passthrough here; the real
// backend detection and its escape self-test have their own suite.
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-codex-'));
const fakeSource = path.join(here, 'fixtures', 'fakeCodexAppServer.mjs');
// A tiny launcher stands in for the installed binary so `--version` and the
// sandboxed launch both reach the fixture without inheriting the test process
// environment. It lives outside the data directory, because a launcher inside it
// cannot be mounted without exposing the database and the encryption key.
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-codex-bin-'));
const fakeBinary = path.join(binDir, 'codex');
const configPath = path.join(dataDir, 'fake-codex.json');
const recordPath = path.join(dataDir, 'launch.json');
const approvalPath = path.join(dataDir, 'approval.json');

process.env.DATA_DIR = dataDir;
process.env.AI_CODEX_ENABLED = 'true';
process.env.AI_CODEX_BIN = fakeBinary;
process.env.AI_CODEX_RUNTIME_DIR = path.join(dataDir, 'ai-codex');
// Present in the manager's own environment on purpose: the runtime must never
// inherit it, so an accidental API-key mode is impossible.
process.env.OPENAI_API_KEY = 'inherited-platform-key-must-not-leak';

vi.mock('../src/services/ai/codex/isolation.js', async () => {
    const actual = await vi.importActual('../src/services/ai/codex/isolation.js');
    return {
        ...actual,
        resolveIsolation: async () => ({ available: true, backend: 'test-passthrough', grade: 'isolated', handle: { name: 'test-passthrough' } }),
        // Keeps the real environment construction so inheritance is still proven;
        // only the interpreter path and the fixture's own config pointer are
        // added so the synthetic server can start at all.
        wrapCommand: (_backend, { codexHome, workDir, command }) =>
            ({ file: command[0], args: command.slice(1), environment: actual.sandboxEnvironment(codexHome, workDir) })
    };
});

let db, ai, jobs, account, credentials, readiness, runtime, client, migrateAiSchema;
// Captured right after the modules load and before any runtime exists.
let signalListenersAfterImport = null;
const admin = { id: 1, is_admin: true };
const user = { id: 1, is_admin: false };
const other = { id: 2, is_admin: false };
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

function fake(overrides = {}) {
    fs.writeFileSync(configPath, JSON.stringify({ version: '0.154.0', recordPath, recordApprovalPath: approvalPath, ...overrides }));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function thrown(run) {
    try { run(); } catch (error) { return error; }
    throw new Error('expected a rejection');
}
// A stopped runtime releases its lease only once its child has exited, so tests
// that seed a lease of their own wait for the table to be quiet first.
async function idleRuntimes() {
    await until(() => db.prepare('SELECT count(*) AS n FROM ai_codex_runtimes').get().n === 0, 10000);
}
async function seedLease(connectionId, leaseId, { pid = 123456, state = 'running', owner = 'user:1' } = {}) {
    await idleRuntimes();
    const now = Date.now();
    db.prepare('INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(owner, connectionId, leaseId, pid, state, now + 60000, now);
}
async function until(check, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await wait(25);
    }
    throw new Error('condition not reached in time');
}

beforeAll(async () => {
    fs.writeFileSync(fakeBinary, `#!/bin/sh\nFAKE_CODEX_CONFIG=${configPath} exec ${process.execPath} ${fakeSource} "$@"\n`, { mode: 0o755 });
    fake();
    ({ default: db } = await import('../src/database/db.js'));
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE admin_users (id INTEGER PRIMARY KEY, username TEXT, is_active INTEGER, token_version INTEGER DEFAULT 0);
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_active INTEGER, webui_access INTEGER, expiry_date INTEGER, token_version INTEGER DEFAULT 0);
        INSERT INTO admin_users VALUES (1,'root',1,0);
        INSERT INTO users VALUES (1,'first',1,1,NULL,0),(2,'second',1,1,NULL,0);`);
    ({ migrateAiSchema } = await import('../src/database/migrationAi.js'));
    migrateAiSchema(db);
    ai = await import('../src/services/ai/connections.js');
    jobs = await import('../src/services/ai/jobs.js');
    account = await import('../src/services/ai/codex/account.js');
    credentials = await import('../src/services/ai/codex/credentials.js');
    readiness = await import('../src/services/ai/codex/readiness.js');
    runtime = await import('../src/services/ai/codex/runtime.js');
    client = await import('../src/services/ai/codex/client.js');
    signalListenersAfterImport = process.listenerCount('SIGTERM');
    await readiness.refreshCodexReadiness({ force: true });
});

afterAll(() => {
    runtime?.stopAllRuntimes();
    account?.releaseAllAttempts();
    db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
});

beforeEach(async () => {
    runtime.stopAllRuntimes();
    account.releaseAllAttempts();
    await idleRuntimes().catch(() => null);
    for (const table of ['ai_connections', 'ai_preferences', 'ai_usage', 'ai_jobs', 'ai_codex_credentials', 'ai_codex_logins', 'ai_codex_runtimes']) db.exec(`DELETE FROM ${table}`);
    db.exec('DELETE FROM settings; UPDATE users SET is_active=1, webui_access=1, expiry_date=NULL, token_version=0; UPDATE admin_users SET is_active=1, token_version=0');
    fs.rmSync(path.join(dataDir, 'ai-codex'), { recursive: true, force: true });
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(approvalPath, { force: true });
    process.env.AI_CODEX_ENABLED = 'true';
    fake();
    readiness.resetCodexReadiness();
    await readiness.refreshCodexReadiness({ force: true });
});

function policy() {
    ai.updateAiSettings(admin, { enabled: true, allow_own_connections: true, allowed_user_ids: [1, 2], functions: ['list', 'search'], internal_targets: [] });
}
function createConnection(actor = user, input = {}) {
    policy();
    const connection = ai.saveConnection(actor, { name: 'My ChatGPT', provider: 'chatgpt_account', functions: ['list', 'search'], ...input });
    ai.savePreferences(actor, { enabled: true, connection_id: connection.id });
    return connection;
}
async function link(actor, connection) {
    const started = await account.startAccountLink(actor, ownedRecord(actor, connection.id), 'session-fingerprint');
    // `sealing` is a running state too: a sign-in is finished when its row is
    // terminal, not when it has left `pending`.
    await until(() => !['starting', 'pending', 'sealing'].includes(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status));
    return { started, state: account.readLoginStatus(actor, ownedRecord(actor, connection.id), started.id, 'session-fingerprint') };
}
function ownedRecord(actor, id) {
    return ai.ownedAccountConnection(actor, id);
}
async function linkedConnection(actor = user) {
    const connection = createConnection(actor);
    const { state } = await link(actor, connection);
    expect(state.status).toBe('completed');
    return ai.listConnections(actor).find(item => item.id === connection.id);
}
async function withModel(actor = user) {
    const connection = await linkedConnection(actor);
    await ai.discoverModels(actor, connection.id);
    await ai.testModels(actor, connection.id, { model_ids: ['model-beta'] });
    ai.saveConnection(actor, { model_id: 'model-beta' }, connection.id);
    ai.savePreferences(actor, { model_id: 'model-beta' });
    return ai.listConnections(actor).find(item => item.id === connection.id);
}

describe('personal ChatGPT adapter availability', () => {
    it('is disabled by default and starts no runtime', async () => {
        delete process.env.AI_CODEX_ENABLED;
        readiness.resetCodexReadiness();
        expect(readiness.codexReadinessSnapshot()).toEqual({ available: false, reason: 'AI_CODEX_DISABLED' });
        expect(account.codexStatus().available).toBe(false);
        policy();
        expect(thrown(() => ai.saveConnection(user, { name: 'x', provider: 'chatgpt_account' })).code).toBe('AI_CODEX_DISABLED');
        expect(fs.existsSync(recordPath)).toBe(false);
    });

    it('charges runtime startup against the caller\'s deadline', async () => {
        // The handshake is part of the operation. Left outside the budget, a slow
        // host outlives the reservation that bounds the request.
        fake({ initializeDelayMs: 800, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        await idleRuntimes();
        const started = Date.now();
        await expect(runtime.startRuntime('user:1', connection.id, { deadline: Date.now() + 300 }))
            .rejects.toMatchObject({ code: 'AI_TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(700);
        await idleRuntimes();
    }, 30000);

    it('spends one deadline across the whole turn, not one per phase', async () => {
        // A server that is slow to acknowledge the turn and then never completes
        // it. Giving each phase its own budget would hold the runtime for a
        // multiple of the caller's limit, past the reservation that bounds it.
        fake({ threadDelayMs: 150, turnStartDelayMs: 400, turn: 'stall', recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        const started = Date.now();
        try {
            await expect(client.runTurn(session, {
                model: 'model-beta', messages: [{ role: 'user', content: 'x' }], schema, timeoutMs: 800
            })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
        } finally { runtime.stopRuntime(session); }
        // Well under the two budgets the phases would otherwise each consume.
        expect(Date.now() - started).toBeLessThan(1300);
    }, 30000);

    it('rechecks access immediately before submitting a billable turn', async () => {
        const turnRecordPath = path.join(dataDir, `turn-${Date.now()}.txt`);
        // Starting the thread takes long enough for access to change, and a
        // compatibility test has no job monitor and no abort signal behind it.
        fake({ threadDelayMs: 400, turnRecordPath, recordPath, recordApprovalPath: approvalPath });
        const connection = await withModel();
        await idleRuntimes();
        // The setup above ran its own turns; only what happens after this counts.
        fs.rmSync(turnRecordPath, { force: true });
        const pending = ai.testModels(user, connection.id, { model_ids: ['model-beta'] });
        await wait(150);
        ai.updateAiSettings(admin, { enabled: false });
        try {
            const result = await pending.catch(error => error);
            // Either the request is refused outright or the profile records the
            // refusal; what must not happen is a submitted turn.
            expect(fs.existsSync(turnRecordPath)).toBe(false);
            if (result instanceof Error) expect(['AI_CONNECTION_CHANGED', 'AI_DISABLED', 'AI_FORBIDDEN']).toContain(result.code);
        } finally {
            ai.updateAiSettings(admin, { enabled: true });
            await idleRuntimes();
        }
    }, 30000);

    it('bounds the whole model catalog by one deadline, not one per page', async () => {
        // Ten pages with their own timeout could hold a runtime for minutes while
        // the reservation that bounds the operation had long expired.
        fake({
            models: Array.from({ length: 20 }, (unused, index) => ({ id: `model-${index}`, displayName: `M${index}`, isDefault: index === 0, inputModalities: ['text'] })),
            modelDelayMs: 200, recordPath, recordApprovalPath: approvalPath
        });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            // One page fits inside the budget; the catalog does not.
            await expect(client.listModels(session, { limit: 2, timeoutMs: 500 }))
                .rejects.toMatchObject({ code: 'AI_TIMEOUT' });
        } finally { runtime.stopRuntime(session); }
    }, 30000);

    it('refuses an unpinned Codex release', async () => {
        fake({ version: '0.99.0' });
        readiness.resetCodexReadiness();
        const result = await readiness.refreshCodexReadiness({ force: true });
        expect(result).toMatchObject({ available: false, reason: 'AI_CODEX_VERSION_UNSUPPORTED' });
    });

    it.each([['0.154.0-beta.1'], ['0.155.0-rc.2'], ['0.154.0+build.7'], ['0.154.0-beta.1+build.5']])('refuses an untested prerelease build (%s)', async version => {
        // The numbers alone fall inside the pinned range; a prerelease of them is
        // not the tested release and must not pass as one.
        fake({ version });
        readiness.resetCodexReadiness();
        expect(await readiness.refreshCodexReadiness({ force: true }))
            .toMatchObject({ available: false, reason: 'AI_CODEX_VERSION_UNSUPPORTED' });
        // Only an operator naming that exact build accepts it.
        process.env.AI_CODEX_VERSION_OVERRIDE = version;
        try {
            readiness.resetCodexReadiness();
            expect(await readiness.refreshCodexReadiness({ force: true })).toMatchObject({ available: true, version });
            // The handshake has to read the same token the probe did, or the
            // exact-version override would be accepted by one gate and refused by
            // the other, leaving the allowed build unusable.
            const connection = createConnection();
            const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'session-fingerprint');
            expect(started.user_code).toBe('ABCD-1234');
            await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
        } finally { delete process.env.AI_CODEX_VERSION_OVERRIDE; }
    }, 30000);

    it('refuses a runtime that reports a different protocol version than the pinned binary', async () => {
        fake({ reportedVersion: '0.140.0' });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
            .rejects.toMatchObject({ code: 'AI_CODEX_VERSION_UNSUPPORTED' });
    });

    it('publishes a completed sign-in only once the credential is stored', async () => {
        const connection = createConnection();
        // Records the state of the credential store at the exact instant the
        // attempt is published as completed. A claim published before the seal
        // would be recorded with no credential behind it, and a poll on another
        // worker would have reported that account as linked.
        db.exec(`CREATE TABLE IF NOT EXISTS test_publish_probe(had_credential INTEGER);
            CREATE TRIGGER test_publish AFTER UPDATE OF status ON ai_codex_logins WHEN NEW.status='completed' BEGIN
                INSERT INTO test_publish_probe VALUES((SELECT count(*) FROM ai_codex_credentials
                    WHERE owner_key=NEW.owner_key AND connection_id=NEW.connection_id));
            END;`);
        try {
            const { state } = await link(user, connection);
            expect(state.status).toBe('completed');
            expect(db.prepare('SELECT had_credential FROM test_publish_probe').all()).toEqual([{ had_credential: 1 }]);
        } finally { db.exec('DROP TRIGGER test_publish; DROP TABLE test_publish_probe'); }
    }, 30000);

    it('reports a cancel that lost the race as still running, never as an internal state', async () => {
        const connection = createConnection();
        await idleRuntimes();
        const now = Date.now();
        // The completion claimed the attempt first and is storing its credential.
        db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
            VALUES('raced-cancel','user:1',?,'login-1','sealing','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
            .run(connection.id, now, now, now + 600000, now);
        // Not cancelled, and not an internal state the browser has no handling
        // for: the sign-in is still running and can still succeed.
        expect(await account.cancelAccountLink(user, ownedRecord(user, connection.id), 'raced-cancel'))
            .toMatchObject({ id: 'raced-cancel', status: 'pending' });
        expect(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get('raced-cancel').status).toBe('sealing');
    }, 30000);

    function abandonedRelink(connectionId, id) {
        const now = Date.now();
        db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
            VALUES(?,'user:1',?,'login-2','sealing','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
            .run(id, connectionId, now, now, now + 600000, now);
    }

    it('does not recover a relink on the credential it was about to replace', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        const before = db.prepare('SELECT login_id,version FROM ai_codex_credentials WHERE owner_key=? AND connection_id=?').get('user:1', connection.id);
        // A second sign-in for an already linked connection, claimed and then
        // abandoned by a dying worker. The credential of the first one is still
        // on record, and an ordinary token refresh advances its version without
        // being this attempt's own result.
        abandonedRelink(connection.id, 'dead-relink');
        db.prepare('UPDATE ai_codex_credentials SET version=version+1 WHERE owner_key=? AND connection_id=?').run('user:1', connection.id);
        // Reporting success here would tell the account holder the new sign-in
        // worked while the previous account stays linked.
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'dead-relink', 'fp'))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_interrupted' });
        expect(db.prepare('SELECT login_id FROM ai_codex_credentials WHERE owner_key=? AND connection_id=?')
            .get('user:1', connection.id).login_id).toBe(before.login_id);
    }, 30000);

    it('reports a relink whose replacement credential was stored as completed', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        abandonedRelink(connection.id, 'stored-relink');
        // The seal did commit before the worker died, naming this attempt.
        db.prepare('UPDATE ai_codex_credentials SET login_id=?, version=version+1 WHERE owner_key=? AND connection_id=?')
            .run('stored-relink', 'user:1', connection.id);
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'stored-relink', 'fp'))
            .toMatchObject({ status: 'completed', error_code: null });
    }, 30000);

    it('ends a claimed sign-in when the connection is disconnected under it', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        // Another worker claimed a relink and is storing its credential while the
        // owner disconnects. Leaving the attempt claimed would let that
        // completion publish a successful sign-in after the link was removed.
        abandonedRelink(connection.id, 'unlinked-sealer');
        await account.disconnectAccount(user, ownedRecord(user, connection.id));
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get('unlinked-sealer'))
            .toMatchObject({ status: 'cancelled', error_code: 'ai_codex_login_cancelled' });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'unlinked-sealer', 'fp').status).toBe('cancelled');
    }, 30000);

    // A completion still in flight: its plaintext credential is on disk and its
    // attempt is claimed. Every case below starts from exactly this state, and
    // each asserts a control seal first, so a refusal is never a missing file.
    function inFlightSeal(connectionId) {
        const paths = credentials.identityPaths('user:1', connectionId);
        credentials.wipe('user:1', connectionId);
        fs.mkdirSync(path.dirname(paths.authFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(paths.authFile, JSON.stringify({ tokens: { access_token: 'synthetic' } }), { mode: 0o600 });
        const now = Date.now();
        db.prepare(`INSERT OR REPLACE INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
            VALUES('late','user:1',?,'login-9','sealing','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
            .run(connectionId, now, now, now + 600000, now);
        return () => credentials.seal('user:1', connectionId, { loginId: 'late', accountHash: 'hash-late' }).sealed;
    }

    it('refuses to store a credential while the connection is tearing down', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        expect(inFlightSeal(connection.id)()).toBe(true);
        const seal = inFlightSeal(connection.id);
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        try {
            expect(seal()).toBe(false);
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        } finally { ai.adjustConnectionTeardown('user:1', connection.id, -1); }
    }, 30000);

    it('refuses to store a credential for an attempt a teardown already ended', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        expect(inFlightSeal(connection.id)()).toBe(true);
        const seal = inFlightSeal(connection.id);
        // What a deletion's or a disconnect's attempt scan does on any worker.
        db.prepare("UPDATE ai_codex_logins SET status='cancelled', error_code='ai_codex_login_cancelled' WHERE id='late'").run();
        expect(seal()).toBe(false);
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('refuses to store a credential for a sign-in whose session was revoked', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        expect(inFlightSeal(connection.id)()).toBe(true);
        const seal = inFlightSeal(connection.id);
        // A password reset while the completion is in flight: the attempt still
        // names the version it was started with.
        db.prepare('UPDATE users SET token_version=7 WHERE id=1').run();
        try {
            expect(seal()).toBe(false);
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        } finally { db.prepare('UPDATE users SET token_version=0 WHERE id=1').run(); }
    }, 30000);

    it('refuses to store a credential for an owner whose access was revoked', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        expect(inFlightSeal(connection.id)()).toBe(true);
        const seal = inFlightSeal(connection.id);
        // An account deletion revokes access before it tears anything down, and a
        // completion in flight on another worker must not slip a credential in.
        db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
        try {
            expect(seal()).toBe(false);
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        } finally { db.prepare('UPDATE users SET is_active=1 WHERE id=1').run(); }
    }, 30000);

    it.each([
        ['reports a sign-in whose worker died before storing anything as interrupted', false,
            { status: 'failed', error_code: 'ai_codex_login_interrupted' }],
        ['still reports a sign-in whose credential was stored before the worker died as completed', true,
            { status: 'completed', error_code: null }]
    ])('%s', async (_label, storeCredential, expected) => {
        const connection = createConnection();
        await idleRuntimes();
        const now = Date.now();
        // A claimed attempt left behind by a worker that no longer holds the
        // identity: only the credential store decides how it ended.
        db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
            VALUES('dead-sealer','user:1',?,'login-1','sealing','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
            .run(connection.id, now, now, now + 600000, now);
        if (storeCredential) {
            db.prepare(`INSERT OR REPLACE INTO ai_codex_credentials(owner_key,connection_id,encrypted_blob,account_hash,login_id,version,updated_at)
                VALUES('user:1',?,'blob','hash-dead-sealer','dead-sealer',1,?)`).run(connection.id, now);
        }
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'dead-sealer', 'fp')).toMatchObject(expected);
    }, 30000);

    it('refuses a runtime that resolved a foreign credential directory', async () => {
        fake({ reportedHome: '/home/someone-else/.codex' });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
            .rejects.toMatchObject({ code: 'AI_CODEX_HOME_MISMATCH' });
    });

    it('launches with the hardened flag set and a sanitized environment', async () => {
        const connection = createConnection();
        await link(user, connection);
        const launch = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        const args = launch.argv.join(' ');
        expect(args).toContain('--strict-config');
        for (const feature of ['shell_tool', 'unified_exec', 'browser_use', 'computer_use', 'apps', 'hooks', 'skill_search', 'view_image']) {
            expect(args).toContain(`--disable ${feature}`);
        }
        for (const override of ['tools.web_search=false', 'mcp_servers={}', 'sandbox_mode="read-only"',
            'shell_environment_policy.inherit="none"', 'history.persistence="none"', 'forced_login_method="chatgpt"']) {
            expect(args).toContain(override);
        }
        // Nothing from the host profile is inherited, so an accidental API-key
        // mode or a plugin root cannot reach the runtime.
        expect(launch.env.OPENAI_API_KEY).toBeUndefined();
        expect(launch.env.DATA_DIR).toBeUndefined();
        expect(launch.env.AI_CODEX_BIN).toBeUndefined();
        expect(launch.env.CODEX_HOME).toBe(credentials.identityPaths('user:1', connection.id).codexHome);
        expect(launch.env.HOME).toBe(launch.env.CODEX_HOME);
    });
});

describe('personal ChatGPT sign-in', () => {
    it('returns only the approved verification address and the device code', async () => {
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(started.verification_url).toBe('https://auth.openai.com/codex/device');
        expect(started.user_code).toBe('ABCD-1234');
        expect(JSON.stringify(started)).not.toContain('synthetic-access-token');
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status === 'completed');
    });

    it('rejects a verification address outside the documented targets', async () => {
        fake({ verificationUrl: 'https://phish.example/codex/device' });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
            .rejects.toMatchObject({ code: 'AI_CODEX_LOGIN_TARGET_BLOCKED' });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('reports a workspace without device-code sign-in without storing anything', async () => {
        fake({ login: 'unsupported' });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp')).rejects.toBeTruthy();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(db.prepare('SELECT status FROM ai_codex_logins').get().status).toBe('failed');
    });

    it('stores a completed sign-in encrypted and leaves no plaintext credential behind', async () => {
        const connection = createConnection();
        const { state } = await link(user, connection);
        expect(state.status).toBe('completed');
        const record = credentials.readCredentialRecord('user:1', connection.id);
        expect(record.encrypted_blob).not.toContain('synthetic-access-token');
        expect(record.account_label).toBe('p***********@example.org');
        expect(record.auth_method).toBe('chatgpt');
        // The sealed copy is the only one that survives the runtime.
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).authFile)).toBe(false);
        const dump = fs.readFileSync(path.join(dataDir, 'db.sqlite'), 'latin1');
        expect(dump).not.toContain('synthetic-access-token');
    });

    it('never exposes a token or a raw address through the connection API', async () => {
        const connection = await linkedConnection();
        expect(connection.account).toMatchObject({ linked: true, plan_type: 'plus', auth_method: 'chatgpt' });
        expect(connection.account.label).not.toContain('pilot.tester');
        expect(JSON.stringify(connection)).not.toContain('synthetic-access-token');
        expect(connection.has_key).toBe(false);
        expect(connection.base_url).toBeNull();
    });

    it('keeps a declined sign-in unlinked', async () => {
        fake({ login: 'declined' });
        const connection = createConnection();
        const { state } = await link(user, connection);
        expect(state.status).toBe('failed');
        expect(state.error_code).toBe('ai_codex_login_rejected');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('reports the real outcome when a completion wins the cancel race', async () => {
        fake({ login: 'success', loginDelayMs: 60 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status === 'completed');
        // Telling the account holder it was cancelled while the account is linked
        // would be the opposite of what happened.
        const result = await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
        expect(result.status).toBe('completed');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
    }, 30000);

    it('cancels a pending sign-in and stores nothing', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        const cancelled = await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
        expect(cancelled.status).toBe('cancelled');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        // The lease outlives `stopRuntime` until the child has actually exited.
        await idleRuntimes();
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
    });

    it('discards a late success after the account session changed', async () => {
        fake({ login: 'success', loginDelayMs: 400 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        // The account signs out (token_version advances) while the code is open.
        db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=1').run();
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        const row = db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id);
        expect(row.status).toBe('failed');
        expect(row.error_code).toBe('ai_codex_login_superseded');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('ignores a completion that names a different login', async () => {
        fake({ login: 'success', completedLoginId: 'someone-elses-login', loginDelayMs: 60 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await wait(400);
        expect(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status).toBe('pending');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
    });

    it('supersedes a previous attempt and bounds repeated starts', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const first = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        const second = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(first.id))
            .toMatchObject({ status: 'cancelled', error_code: 'ai_codex_login_superseded' });
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), second.id, 'fp').status).toBe('pending');
        await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp')).rejects.toMatchObject({ code: 'AI_RATE_LIMIT' });
    });

    it('rejects a foreign connection and a foreign login identifier', async () => {
        const connection = createConnection(user);
        const { started } = await link(user, connection);
        expect(() => ai.ownedAccountConnection(other, connection.id)).toThrow();
        expect(() => ai.ownedAccountConnection(admin, connection.id)).toThrow();
        expect(() => account.readLoginStatus(user, ownedRecord(user, connection.id), 'not-my-login')).toThrow(/AI_NOT_FOUND|not found/i);
        expect(started.id).toBeTruthy();
    });

    it('waits for the discarded sign-in\'s child before freeing its identity', async () => {
        const exitRecordPath = path.join(dataDir, `exit-${Date.now()}.txt`);
        // A sign-in the runtime cannot back with an account: the attempt is
        // discarded. Its child takes a moment to shut down and records that it
        // really exited.
        fake({ accountRead: 'none', exitRecordPath, slowExitMs: 250, recordPath, recordApprovalPath: approvalPath });
        const connection = createConnection();
        const { state } = await link(user, connection);
        expect(state.error_code).toBe('ai_codex_account_unavailable');
        // Freeing the identity while that child is alive would let a new sign-in
        // take it and recreate the same directory underneath the old process, so
        // the lease must outlive the child.
        await until(() => runtime.runtimeState('user:1', connection.id) === null, 10000);
        expect(fs.existsSync(exitRecordPath)).toBe(true);
        await until(() => !fs.existsSync(credentials.identityPaths('user:1', connection.id).root), 10000);
    }, 30000);

    it.each([
        ['the server policy is switched off',
            "UPDATE settings SET value=json_set(value,'$.enabled',json('false')) WHERE key='ai_policy'"],
        ['the owner loses their allowance',
            "UPDATE settings SET value=json_set(value,'$.allowed_user_ids',json('[2]')) WHERE key='ai_policy'"],
        ['the owner turns their own AI off',
            "UPDATE ai_preferences SET data_json=json_set(data_json,'$.enabled',json('false')) WHERE owner_key='user:1'"]
    ])('does not publish a sign-in finalized after %s', async (_label, revoke) => {
        ai.savePreferences(user, { enabled: true });
        const connection = createConnection();
        await idleRuntimes();
        // Access is withdrawn in the window between claiming the completion and
        // publishing it. Polling deliberately reports an attempt without
        // re-applying the policy, so a link published here would read as working.
        db.exec(`CREATE TRIGGER test_revoke_policy AFTER UPDATE OF status ON ai_codex_logins WHEN NEW.status='sealing'
            BEGIN ${revoke}; END;`);
        try {
            const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'session-fingerprint');
            await until(() => !['starting', 'pending', 'sealing'].includes(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status), 10000);
            expect(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status).toBe('failed');
            // The credential this attempt stored is removed with the rest of its
            // state: the owner may not use it at all any more.
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        } finally {
            db.exec('DROP TRIGGER test_revoke_policy');
            await idleRuntimes();
        }
    }, 30000);

    it('lets a superseded start lose the identity to the one that replaced it', async () => {
        fake({ login: 'pending', recordPath, recordApprovalPath: approvalPath });
        const connection = createConnection();
        await idleRuntimes();
        // A second click while the first start is still on its way to the lease:
        // the first attempt is not in any worker's attempt map yet, so nothing can
        // stop it, and it must lose the identity on its own.
        const first = account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        const second = (async () => {
            await until(() => db.prepare("SELECT count(*) AS n FROM ai_codex_logins WHERE connection_id=? AND status='starting'").get(connection.id).n > 0, 5000);
            db.prepare("UPDATE ai_codex_logins SET status='cancelled', error_code='ai_codex_login_superseded' WHERE connection_id=? AND status='starting'").run(connection.id);
        })();
        const [outcome] = await Promise.all([first.catch(error => error), second]);
        expect(outcome).toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        // The identity is free for the request that replaced it, not held by the
        // one that was cancelled.
        await idleRuntimes();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(started.user_code).toBe('ABCD-1234');
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
    }, 30000);

    it('never issues more device codes than the hourly budget, even from parallel starts', async () => {
        fake({ login: 'pending', recordPath, recordApprovalPath: approvalPath });
        // One lease per connection, so these starts really do run side by side.
        const connections = [];
        for (let index = 0; index < 6; index += 1) connections.push(createConnection());
        const results = await Promise.allSettled(connections.map(connection =>
            account.startAccountLink(user, ownedRecord(user, connection.id), `fp-${connection.id}`)));
        const issued = results.filter(result => result.status === 'fulfilled');
        const refused = results.filter(result => result.status === 'rejected');
        expect(issued.length).toBe(5);
        expect(refused.every(result => result.reason?.code === 'AI_RATE_LIMIT')).toBe(true);
        // The budget counts published codes, so the refused attempt recorded none.
        expect(db.prepare("SELECT count(*) AS n FROM ai_codex_logins WHERE owner_key='user:1' AND login_id IS NOT NULL").get().n).toBe(5);
        for (const connection of connections) {
            await account.disconnectAccount(user, ownedRecord(user, connection.id)).catch(() => null);
        }
        await idleRuntimes();
    }, 60000);

    it('keeps the connection when its local teardown fails', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        // A local teardown that cannot complete: ending the connection's open
        // sign-in fails. Removing the connection row anyway would drop the lease
        // and the credential record through the deletion trigger while that
        // teardown never happened, and report success for it.
        const now = Date.now();
        db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
            VALUES('stuck-attempt','user:1',?,'login-3','pending','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
            .run(connection.id, now, now, now + 600000, now);
        db.exec(`CREATE TRIGGER test_attempt_fail BEFORE UPDATE ON ai_codex_logins WHEN OLD.id='stuck-attempt'
            BEGIN SELECT RAISE(ABORT,'attempt could not be ended'); END;`);
        try {
            await expect(ai.removeConnection(user, connection.id)).rejects.toBeTruthy();
        } finally {
            db.exec('DROP TRIGGER test_attempt_fail');
            db.prepare("DELETE FROM ai_codex_logins WHERE id='stuck-attempt'").run();
        }
        const row = db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id);
        expect(row).toBeTruthy();
        // Nothing left blocking the connection that survived, either, and the
        // link it still has is intact.
        expect(JSON.parse(row.data_json).teardown).toBeUndefined();
        expect(credentials.readCredentialRecord('user:1', connection.id)).not.toBeNull();
    }, 30000);

    it('clears the teardown marker when the removal itself is refused', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        // The session is revoked while the sign-out runs, so the deletion at the
        // end is refused. A marker left behind would block every kind of work on
        // a connection that still exists, until a restart.
        const authenticated = { id: 1, is_admin: false, token_version: 0 };
        db.exec(`CREATE TRIGGER test_revoke AFTER UPDATE ON ai_connections WHEN NEW.id='${connection.id}' BEGIN
            UPDATE users SET token_version=9 WHERE id=1;
        END;`);
        try {
            await expect(ai.removeConnection(authenticated, connection.id)).rejects.toMatchObject({ code: 'AI_FORBIDDEN' });
        } finally { db.exec('DROP TRIGGER test_revoke'); db.prepare('UPDATE users SET token_version=0 WHERE id=1').run(); }
        expect(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id)).toBeTruthy();
        expect(JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id).data_json).teardown).toBeUndefined();
    }, 30000);

    it('reports the loser of a duplicate-account race as already linked', async () => {
        const connection = createConnection();
        await idleRuntimes();
        // Two connections can both pass the duplicate check before either stores
        // a credential; the unique index then decides. Modelled by letting the
        // other one appear exactly when this attempt is claimed.
        const hash = credentials.accountFingerprint('pilot.tester@example.org');
        db.exec(`CREATE TRIGGER test_duplicate AFTER UPDATE OF status ON ai_codex_logins WHEN NEW.status='sealing' BEGIN
            INSERT OR IGNORE INTO ai_codex_credentials(owner_key,connection_id,encrypted_blob,account_hash,version,updated_at)
            VALUES('user:2','other-connection','blob','${hash}',1,0);
        END;`);
        try {
            const { state } = await link(user, connection);
            // Not a storage failure: the account holder is told their ChatGPT
            // account is already linked, which is what actually happened.
            expect(state).toMatchObject({ status: 'failed', error_code: 'ai_codex_account_already_linked' });
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        } finally {
            db.exec('DROP TRIGGER test_duplicate');
            db.prepare("DELETE FROM ai_codex_credentials WHERE owner_key='user:2' AND connection_id='other-connection'").run();
        }
    }, 30000);

    it('refuses to link one external account twice', async () => {
        await linkedConnection(user);
        const second = createConnection(other);
        const { state } = await link(other, second);
        expect(state.status).toBe('failed');
        expect(state.error_code).toBe('ai_codex_account_already_linked');
        expect(credentials.readCredentialRecord('user:2', second.id)).toBeNull();
        expect(credentials.readCredentialRecord('user:1', db.prepare("SELECT id FROM ai_connections WHERE owner_key='user:1'").get().id)).toBeTruthy();
    });

    it('separates an administrator and a normal user with the same numeric id', async () => {
        const userConnection = await linkedConnection(user);
        fake({ email: 'admin.tester@example.org' });
        const adminConnection = createConnection(admin);
        const { state } = await link(admin, adminConnection);
        expect(state.status).toBe('completed');
        expect(credentials.readCredentialRecord('admin:1', adminConnection.id).account_label).toBe('a***********@example.org');
        expect(credentials.readCredentialRecord('user:1', userConnection.id).account_label).toBe('p***********@example.org');
        expect(ai.listConnections(admin).some(item => item.id === userConnection.id)).toBe(false);
    });
});

describe('personal ChatGPT sign-in ownership across workers and sessions', () => {
    it('keeps a sign-in pending when the poll lands on a worker that does not own it', async () => {
        const connection = createConnection();
        // A runtime lease held by another worker, with no attempt in this
        // process: exactly what a poll without sticky routing sees.
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            const now = Date.now();
            db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at,last_seen_at)
                VALUES('foreign-worker','user:1',?,'login-1','pending','https://auth.openai.com/codex/device','ABCD-1234',0,'fp',?,?,?,?)`)
                .run(connection.id, now, now, now + 600000, now);
            expect(runtime.runtimeState('user:1', connection.id)).toBeTruthy();
            expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'foreign-worker', 'fp').status).toBe('pending');
        } finally { runtime.stopRuntime(session); }
        await idleRuntimes();
        // Once no worker holds the lease the attempt really is gone.
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), 'foreign-worker', 'fp'))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_interrupted' });
    });

    it('hides an attempt from a different session and refreshes liveness on its own poll', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'owning-session');
        expect(thrown(() => account.readLoginStatus(user, ownedRecord(user, connection.id), started.id, 'another-session')).status).toBe(404);
        const before = db.prepare('SELECT last_seen_at FROM ai_codex_logins WHERE id=?').get(started.id).last_seen_at;
        db.prepare('UPDATE ai_codex_logins SET last_seen_at=? WHERE id=?').run(before - 60000, started.id);
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), started.id, 'owning-session').status).toBe('pending');
        expect(db.prepare('SELECT last_seen_at FROM ai_codex_logins WHERE id=?').get(started.id).last_seen_at).toBeGreaterThan(before - 60000);
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
    });

    it.each([
        ['Web UI access is revoked', () => db.prepare('UPDATE users SET webui_access=0 WHERE id=1').run()],
        ['the account has expired', () => db.prepare('UPDATE users SET expiry_date=? WHERE id=1').run(Math.floor(Date.now() / 1000) - 60)]
    ])('discards a success that arrives after %s', async (_label, revoke) => {
        fake({ login: 'success', loginDelayMs: 500 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        revoke();
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_superseded' });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('discards a success that arrives after the initiating session stopped watching', async () => {
        fake({ login: 'success', loginDelayMs: 600 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'owning-session');
        // The browser session ends. Sign-out here is client side and does not
        // advance token_version, so the attempt is only kept alive by polling.
        db.prepare('UPDATE ai_codex_logins SET last_seen_at=? WHERE id=?').run(Date.now() - 600000, started.id);
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_superseded' });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('does not link an account after the attempt was cancelled mid-completion', async () => {
        // The completion arrives while the account is being read; the cancel
        // lands in that same window.
        fake({ login: 'success', loginDelayMs: 250 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        db.prepare("UPDATE ai_codex_logins SET status='cancelled', error_code='ai_codex_login_cancelled', updated_at=? WHERE id=?")
            .run(Date.now(), started.id);
        await until(() => !runtime.liveRuntime('user:1', connection.id));
        // An explicitly cancelled sign-in must never leave the account linked.
        expect(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status).toBe('cancelled');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).authFile)).toBe(false);
    }, 30000);

    it.each([
        ['the server policy is switched off', () => ai.updateAiSettings(admin, { enabled: false })],
        ['the owner loses their allowance', () => ai.updateAiSettings(admin, { allowed_user_ids: [2] })],
        ['the owner turns their own AI off', () => ai.savePreferences(user, { enabled: false })]
    ])('discards a completion after %s', async (_label, revoke) => {
        fake({ login: 'success', loginDelayMs: 500 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        revoke();
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_superseded' });
        // Access withdrawn during a sign-in must not be granted by its completion.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it.each([
        ['no account is reported', { accountRead: 'none' }, 'ai_codex_account_unavailable'],
        ['the account cannot be identified', { emailNull: true }, 'ai_codex_account_unidentified']
    ])('discards a completion when %s', async (_label, overrides, expected) => {
        fake({ login: 'success', loginDelayMs: 60, ...overrides });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id))
            .toMatchObject({ status: 'failed', error_code: expected });
        // Nothing may be reported as linked that the runtime cannot back.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(ai.listConnections(user).find(item => item.id === connection.id).account.linked).toBe(false);
    }, 30000);

    it('keeps the attempt running when a completion names another login', async () => {
        fake({ login: 'mismatchThenSuccess', loginDelayMs: 40, secondLoginDelayMs: 400 });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        // The foreign completion must not stop the runtime that is still waiting.
        await wait(200);
        expect(db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status).toBe('pending');
        expect(runtime.liveRuntime('user:1', connection.id)).toBeTruthy();
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status === 'completed');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
    });
});

describe('personal ChatGPT runtime robustness', () => {
    it('clears a plaintext credential left behind by a runtime that never tore down', async () => {
        const connection = await linkedConnection();
        const paths = credentials.identityPaths('user:1', connection.id);
        // A killed worker leaves the hydrated file behind; nothing removes it and
        // it would otherwise reach a data-directory backup.
        credentials.hydrate('user:1', connection.id);
        expect(fs.existsSync(paths.authFile)).toBe(true);
        credentials.resetInterruptedRuntimes();
        const swept = credentials.sweepOrphans();
        expect(swept.cleared).toBeGreaterThan(0);
        expect(fs.existsSync(paths.authFile)).toBe(false);
        // The sealed record and its directory survive: the account stays linked.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
        expect(fs.existsSync(paths.root)).toBe(true);
    });

    it('releases a dead worker\'s lease and plaintext without waiting for a full restart', async () => {
        const connection = await linkedConnection();
        const paths = credentials.identityPaths('user:1', connection.id);
        credentials.hydrate('user:1', connection.id);
        // A worker that was killed while holding its lease. The primary keeps
        // running, so the startup sweep is not going to happen.
        await seedLease(connection.id, 'dead-worker-lease', { pid: 987654 });
        expect(fs.existsSync(paths.authFile)).toBe(true);
        const released = credentials.releaseWorkerRuntimes(987654);
        expect(released).toMatchObject({ leases: 1, cleared: 1 });
        expect(fs.existsSync(paths.authFile)).toBe(false);
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        // The link itself and its directory survive the worker's death.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
        expect(fs.existsSync(paths.root)).toBe(true);
    });

    it('clears the plaintext of a worker that died before its sign-in was sealed', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        const paths = credentials.identityPaths('user:1', connection.id);
        // Codex wrote its credential file, but the worker died before sealing, so
        // there is no credential record for the record-driven pass to find.
        fs.mkdirSync(paths.codexHome, { recursive: true });
        fs.writeFileSync(paths.authFile, JSON.stringify({ tokens: { access_token: 'unsealed-token' } }), { mode: 0o600 });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        const pid = db.prepare('SELECT worker_pid FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get('user:1', connection.id).worker_pid;
        account.releaseAllAttempts();
        await idleRuntimes();
        fs.writeFileSync(paths.authFile, JSON.stringify({ tokens: { access_token: 'unsealed-token' } }), { mode: 0o600 });
        await seedLease(connection.id, 'dead', { pid });
        expect(credentials.releaseWorkerRuntimes(pid).cleared).toBeGreaterThan(0);
        expect(fs.existsSync(paths.authFile)).toBe(false);
        expect(started.status).toBe('pending');
    }, 30000);

    it('refuses to store a credential for a connection that was deleted meanwhile', async () => {
        const connection = await linkedConnection();
        const paths = credentials.identityPaths('user:1', connection.id);
        const fingerprint = credentials.readCredentialRecord('user:1', connection.id).account_hash;
        credentials.wipe('user:1', connection.id);
        fs.mkdirSync(paths.codexHome, { recursive: true });
        fs.writeFileSync(paths.authFile, JSON.stringify({ tokens: { access_token: 'late-token' } }), { mode: 0o600 });
        // The connection is gone; its deletion trigger has already run.
        db.prepare('DELETE FROM ai_connections WHERE id=?').run(connection.id);
        expect(credentials.seal('user:1', connection.id, { accountHash: fingerprint })).toEqual({ sealed: false });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        // An orphan would have kept this account fingerprint reserved for ever.
        expect(credentials.linkedElsewhere('user:2', 'other-connection', fingerprint)).toBe(false);
    });

    it('removes a credential left over from a connection that no longer exists', async () => {
        const connection = await linkedConnection();
        const fingerprint = credentials.readCredentialRecord('user:1', connection.id).account_hash;
        db.prepare('DELETE FROM ai_connections WHERE id=?').run(connection.id);
        db.prepare(`INSERT OR REPLACE INTO ai_codex_credentials(owner_key,connection_id,encrypted_blob,account_hash,version,updated_at)
            VALUES('user:1',?,'stale-blob',?,1,?)`).run(connection.id, fingerprint, Date.now());
        credentials.sweepOrphans();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(credentials.linkedElsewhere('user:2', 'other-connection', fingerprint)).toBe(false);
    });

    it('leaves another live worker\'s plaintext credential alone while recovering one', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
            // Recovering an unrelated worker must not touch a leased runtime.
            expect(credentials.releaseWorkerRuntimes(987654)).toMatchObject({ leases: 0, cleared: 0 });
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
        } finally { runtime.stopRuntime(session); }
    });

    it('fails a sign-in whose runtime dies after issuing the device code', async () => {
        fake({ exitAfterLogin: true, exitAfterLoginMs: 40, recordPath, recordApprovalPath: approvalPath });
        const connection = createConnection();
        let started = null;
        try { started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'); }
        catch (error) { expect(error.code).toMatch(/^AI_CODEX_RUNTIME_/); }
        // Nothing can complete the sign-in, so it must not keep reporting pending
        // until the fifteen-minute expiry.
        await until(() => db.prepare("SELECT status FROM ai_codex_logins WHERE owner_key='user:1'").get()?.status !== 'pending');
        const row = db.prepare("SELECT status,error_code FROM ai_codex_logins WHERE owner_key='user:1'").get();
        expect(row).toMatchObject({ status: 'failed', error_code: 'ai_codex_login_interrupted' });
        if (started) {
            expect(account.readLoginStatus(user, ownedRecord(user, connection.id), started.id, 'fp'))
                .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_interrupted' });
        }
        // The lease is released, so the account holder can start again at once.
        await until(() => runtime.runtimeState('user:1', connection.id) === null);
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('leaves a live runtime\'s plaintext credential alone', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
            expect(credentials.sweepOrphans().cleared).toBe(0);
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
        } finally { runtime.stopRuntime(session); }
    });

    // A supersede routed to another worker leaves that worker's lease in the
    // shared table while this process has no runtime of its own for it. Holding
    // only the database lease reproduces exactly that state.
    const holdForeignLease = connectionId => seedLease(connectionId, 'foreign-lease', { pid: 424242 });
    const dropForeignLease = connectionId =>
        db.prepare("DELETE FROM ai_codex_runtimes WHERE connection_id=? AND lease_id='foreign-lease'").run(connectionId);

    it('waits for the previous runtime to hand over its lease before replacing it', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        await holdForeignLease(connection.id);
        expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
        const released = setTimeout(() => dropForeignLease(connection.id), 500);
        released.unref?.();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(started.status).toBe('pending');
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
    }, 30000);

    it('refuses a collision that never hands over, without recording an attempt', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        await holdForeignLease(connection.id);
        try {
            const before = db.prepare('SELECT count(*) AS n FROM ai_codex_logins').get().n;
            await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
                .rejects.toMatchObject({ code: 'AI_BUSY' });
            // No row, so a collision never spends part of the hourly budget.
            expect(db.prepare('SELECT count(*) AS n FROM ai_codex_logins').get().n).toBe(before);
        } finally { dropForeignLease(connection.id); }
    }, 30000);

    it('charges the hourly budget only for attempts that produced a device code', async () => {
        fake({ login: 'unsupported' });
        const connection = createConnection();
        for (let attempt = 0; attempt < 6; attempt += 1) {
            await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
                .rejects.toMatchObject({ code: expect.not.stringContaining('AI_RATE_LIMIT') });
        }
        expect(db.prepare('SELECT count(*) AS n FROM ai_codex_logins WHERE login_id IS NOT NULL').get().n).toBe(0);
        fake({ login: 'pending' });
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(started.status).toBe('pending');
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
    }, 30000);

    it('reports a runtime that exits before the first request instead of crashing the worker', async () => {
        fake({ exitOnStart: true, recordPath, recordApprovalPath: approvalPath });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
            .rejects.toMatchObject({ code: expect.stringMatching(/^AI_CODEX_RUNTIME_/) });
        // The lease is released, so a later attempt is not blocked.
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        expect(db.prepare('SELECT status FROM ai_codex_logins').get().status).toBe('failed');
    });

    it('resolves the runtime to an absolute path so the sandbox can launch it', async () => {
        const previousPath = process.env.PATH;
        const previousBin = process.env.AI_CODEX_BIN;
        // The documented default: a bare name that only the host PATH resolves.
        process.env.PATH = `${binDir}:${previousPath}`;
        process.env.AI_CODEX_BIN = 'codex';
        try {
            readiness.resetCodexReadiness();
            const availability = await readiness.refreshCodexReadiness({ force: true });
            expect(availability.available).toBe(true);
            expect(path.isAbsolute(availability.binary)).toBe(true);
            const connection = createConnection();
            const { state } = await link(user, connection);
            expect(state.status).toBe('completed');
            expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).argv[0]).toBe('app-server');
        } finally {
            process.env.PATH = previousPath;
            process.env.AI_CODEX_BIN = previousBin;
            readiness.resetCodexReadiness();
            await readiness.refreshCodexReadiness({ force: true });
        }
    });

    it('resolves a configured relative runtime path before sandboxing', async () => {
        const isolation = await vi.importActual('../src/services/ai/codex/isolation.js');
        const relative = path.relative(process.cwd(), fakeBinary);
        expect(path.isAbsolute(relative)).toBe(false);
        // bwrap changes into the identity work directory, where a path relative
        // to the manager's working directory no longer exists.
        expect(isolation.which(`./${relative}`)).toBe(fakeBinary);
        expect(isolation.which('./does-not-exist/codex')).toBeNull();
    });

    it('mounts the target and package root of a symlinked launcher', async () => {
        const isolation = await vi.importActual('../src/services/ai/codex/isolation.js');
        // The shape a global npm install produces: a bin symlink into a package.
        const packageRoot = path.join(dataDir, 'lib', 'node_modules', '@openai', 'codex');
        const binDirectory = path.join(dataDir, 'globalbin');
        fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
        fs.mkdirSync(binDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@openai/codex"}');
        const target = path.join(packageRoot, 'bin', 'codex.js');
        fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const launcher = path.join(binDirectory, 'codex');
        fs.rmSync(launcher, { force: true });
        fs.symlinkSync(target, launcher);
        // Mounts use the kernel-resolved path, which on macOS differs from the
        // symlinked temporary path the test built. The launcher and its target
        // are bound as files; only the package root is a directory, because a
        // packaged launcher needs the files it ships with.
        const real = candidate => fs.realpathSync.native(candidate);
        const mounts = isolation.launcherMounts(launcher);
        expect(mounts).toContain(launcher);
        expect(mounts).toContain(real(target));
        expect(mounts).toContain(real(packageRoot));
        expect(mounts).not.toContain(binDirectory);
        // The launcher's own directory also has to be on the sandbox PATH, since
        // a wrapper script commonly executes a sibling interpreter.
        expect(isolation.sandboxEnvironment('/tmp/home', '/tmp/work', [binDirectory]).PATH.startsWith(`${binDirectory}:`)).toBe(true);
    });

    it('keeps the adapter unavailable for a launcher placed in the data directory', async () => {
        const previousBin = process.env.AI_CODEX_BIN;
        const inside = path.join(dataDir, 'codex-inside-data');
        fs.copyFileSync(fakeBinary, inside);
        fs.chmodSync(inside, 0o755);
        process.env.AI_CODEX_BIN = inside;
        try {
            readiness.resetCodexReadiness();
            expect(await readiness.refreshCodexReadiness({ force: true }))
                .toMatchObject({ available: false, reason: 'AI_CODEX_BINARY_UNSAFE_LOCATION' });
            policy();
            expect(thrown(() => ai.saveConnection(user, { name: 'x', provider: 'chatgpt_account' })).code)
                .toBe('AI_CODEX_BINARY_UNSAFE_LOCATION');
        } finally {
            process.env.AI_CODEX_BIN = previousBin;
            readiness.resetCodexReadiness();
            await readiness.refreshCodexReadiness({ force: true });
        }
    });

    it('installs one shutdown handler, and only once a runtime exists', async () => {
        // Loading the module must not change Node's signal behavior: a listener
        // that only cleans up would suppress termination on a host where the
        // adapter is switched off entirely.
        expect(signalListenersAfterImport).toBe(0);
        const connection = await linkedConnection();
        const first = await runtime.startRuntime('user:1', connection.id);
        const installed = process.listenerCount('SIGTERM');
        runtime.stopRuntime(first);
        expect(installed).toBe(1);
        const second = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(second);
        // Never stacked, however many runtimes come and go.
        expect(process.listenerCount('SIGTERM')).toBe(1);
    });
});

describe('personal ChatGPT connection privacy', () => {
    it('refuses to share the connection and forces private storage', () => {
        policy();
        expect(() => ai.saveConnection(admin, { name: 'Shared attempt', provider: 'chatgpt_account', shared: true, allowed_user_ids: [2] }))
            .toThrow(/AI_FORBIDDEN|not permitted/i);
        const connection = ai.saveConnection(admin, { name: 'Private', provider: 'chatgpt_account' });
        // Directly manipulated storage must not become shareable on read either.
        const row = db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id);
        const tampered = { ...JSON.parse(row.data_json), shared: true, allowed_user_ids: [2] };
        db.prepare('UPDATE ai_connections SET data_json=? WHERE id=?').run(JSON.stringify(tampered), connection.id);
        expect(ai.listConnections(other).some(item => item.id === connection.id)).toBe(false);
        expect(() => ai.savePreferences(other, { connection_id: connection.id })).toThrow();
        expect(() => ai.requireAiAccess(other, 'list', connection.id)).toThrow();
    });

    it('rejects a user-supplied address, key or token parameter', () => {
        policy();
        for (const input of [{ base_url: 'https://example.com/v1' }, { api_key: 'sk-test' }, { token_parameter: 'max_tokens' }]) {
            expect(() => ai.saveConnection(user, { name: 'x', provider: 'chatgpt_account', ...input })).toThrow(/AI_INVALID_INPUT|Invalid/i);
        }
    });

    it('still allows disabling and deleting an existing connection after the host loses its runtime', async () => {
        const connection = createConnection();
        delete process.env.AI_CODEX_ENABLED;
        readiness.resetCodexReadiness();
        expect(thrown(() => ai.saveConnection(user, { name: 'x', provider: 'chatgpt_account' })).code).toBe('AI_CODEX_DISABLED');
        expect(ai.saveConnection(user, { enabled: false, name: 'Renamed' }, connection.id)).toMatchObject({ enabled: false, name: 'Renamed' });
        expect(ai.deleteConnection(user, connection.id)).toEqual({ deleted: true });
    });

    it.each([
        ['the credential file is a link', paths => {
            fs.rmSync(paths.authFile, { force: true });
            fs.symlinkSync(paths.victim, paths.authFile);
        }],
        ['the credential directory is a link', paths => {
            fs.rmSync(paths.codexHome, { recursive: true, force: true });
            fs.symlinkSync(path.dirname(paths.victim), paths.codexHome);
        }]
    ])('never seals another identity\'s credential when %s', async (_label, tamper) => {
        const mine = await linkedConnection(user);
        const before = credentials.readCredentialRecord('user:1', mine.id);
        // A second identity with a plaintext credential of its own.
        fake({ email: 'second.tester@example.org' });
        const theirs = createConnection(other);
        expect((await link(other, theirs)).state.status).toBe('completed');
        const theirPaths = credentials.identityPaths('user:2', theirs.id);
        fs.mkdirSync(theirPaths.codexHome, { recursive: true });
        fs.writeFileSync(theirPaths.authFile, JSON.stringify({ tokens: { access_token: 'victim-token' } }), { mode: 0o600 });

        // The sandboxed runtime can write in its own directory, so it could put a
        // link where its credential file belongs. Following it would seal the
        // other account's token into this record.
        const myPaths = credentials.identityPaths('user:1', mine.id);
        fs.mkdirSync(myPaths.codexHome, { recursive: true });
        fs.writeFileSync(myPaths.authFile, '{}', { mode: 0o600 });
        tamper({ ...myPaths, victim: theirPaths.authFile });

        expect(credentials.seal('user:1', mine.id, {}, { refreshOnly: true })).toEqual({ sealed: false });
        const after = credentials.readCredentialRecord('user:1', mine.id);
        expect(after.encrypted_blob).toBe(before.encrypted_blob);
        expect(after.version).toBe(before.version);
    }, 30000);

    it('never seals a credential file caught mid-write', async () => {
        const connection = await linkedConnection();
        const before = credentials.readCredentialRecord('user:1', connection.id);
        const paths = credentials.identityPaths('user:1', connection.id);
        fs.mkdirSync(paths.codexHome, { recursive: true });
        fs.writeFileSync(paths.authFile, '{"tokens":{"access_token":"trunc');
        expect(credentials.seal('user:1', connection.id, {}, { refreshOnly: true })).toEqual({ sealed: false });
        expect(credentials.readCredentialRecord('user:1', connection.id).encrypted_blob).toBe(before.encrypted_blob);
    });

    it('never changes the provider of an existing connection', () => {
        const connection = createConnection();
        expect(() => ai.saveConnection(user, { provider: 'openai_api' }, connection.id)).toThrow(/AI_INVALID_INPUT|Invalid/i);
        expect(ai.listConnections(user)[0].provider).toBe('chatgpt_account');
    });

    it('keeps existing API connections on the default provider with key and model intact', async () => {
        policy();
        db.prepare('INSERT INTO ai_connections(id,owner_key,data_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?)')
            .run('legacy-1', 'user:1', JSON.stringify({
                name: 'Legacy', base_url: 'https://legacy.example/v1', encrypted_key: 'stored', shared: false, allowed_user_ids: [],
                functions: ['list'], enabled: true, model_id: 'legacy-model', models: [{ id: 'legacy-model', candidate: 'text' }],
                capabilities: { 'legacy-model': { id: 'legacy-model', chat: true, structured: true, status: 'compatible', token_parameter: 'max_tokens' } },
                token_parameter: 'max_tokens'
            }), 1, Date.now(), Date.now());
        migrateAiSchema(db);
        const [connection] = ai.listConnections(user);
        expect(connection).toMatchObject({ provider: 'openai_api', model_id: 'legacy-model', has_key: true, base_url: 'https://legacy.example/v1' });
        expect(connection.account).toBeUndefined();
    });

    it('blocks unattended work but keeps a deliberate request available', async () => {
        const connection = await withModel();
        expect(ai.allowsUnattendedWork(connection.id)).toBe(false);
        expect(() => jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'auto-key-000001', { automatic: true }))
            .toThrow(/ai_codex_manual_only/);
        const created = jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'manual-key-00001');
        expect(created.status).toBe('queued');
        jobs.cancelJob(user, created.id);
    });

    it('refuses to queue a request for an unlinked account and binds a queued job to it', async () => {
        const connection = await withModel();
        const queued = jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'bound-key-000001');
        const stored = JSON.parse(db.prepare('SELECT input_json FROM ai_jobs WHERE id=?').get(queued.id).input_json);
        expect(stored._account).toMatchObject({ linked: true });
        expect(typeof stored._account.hash).toBe('string');
        jobs.cancelJob(user, queued.id);
        credentials.wipe('user:1', connection.id);
        expect(thrown(() => jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'unlinked-key-0001')).code).toBe('AI_CODEX_NOT_LINKED');
        // A diagnosis keeps its local findings and only loses the optional explanation.
        ai.updateAiSettings(admin, { enabled: true, allow_own_connections: true, allowed_user_ids: [1, 2], functions: ['list', 'search', 'diagnose'], internal_targets: [] });
        ai.saveConnection(user, { functions: ['list', 'search', 'diagnose'] }, connection.id);
        let diagnoseError = null;
        try { jobs.createJob(user, { feature: 'diagnose' }, 'diagnose-key-0001'); } catch (error) { diagnoseError = error; }
        expect(diagnoseError?.code).not.toBe('AI_CODEX_NOT_LINKED');
    });

    it('applies the operator policy to outbound account work but never strands a stored sign-in', async () => {
        const connection = await linkedConnection();
        // The administrator revokes AI access after the account was linked.
        ai.updateAiSettings(admin, { enabled: true, allow_own_connections: true, allowed_user_ids: [2], functions: ['list', 'search'], internal_targets: [] });
        // Starting a sign-in and reading the account both go through the gated
        // handle, so both are refused once access is revoked.
        expect(thrown(() => ai.ownedAccountConnection(user, connection.id)).code).toBe('AI_FORBIDDEN');
        // Cancelling and disconnecting stay reachable so the owner can remove it.
        const relaxed = ai.ownedAccountConnection(user, connection.id, { requirePolicy: false });
        expect(relaxed.id).toBe(connection.id);
        const result = await account.disconnectAccount(user, relaxed);
        expect(result.disconnected).toBe(true);
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('keeps a job bound to the account identity across the token seals of its own turn', async () => {
        const connection = await withModel();
        const before = ai.accountBinding(connection.id);
        await ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema });
        // A completed turn seals a refreshed token more than once; the binding
        // must survive that, or an already billed answer would be discarded.
        expect(ai.accountBinding(connection.id)).toEqual(before);
        credentials.wipe('user:1', connection.id);
        expect(ai.accountBinding(connection.id)).not.toEqual(before);
    });

    it('requires a linked account before any billable request', async () => {
        const connection = await withModel();
        credentials.wipe('user:1', connection.id);
        const before = db.prepare('SELECT count(*) AS n FROM ai_usage').get().n;
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_NOT_LINKED' });
        // The refusal happens before any reservation, so no call budget is spent.
        expect(db.prepare('SELECT count(*) AS n FROM ai_usage').get().n).toBe(before);
    });
});

describe('personal ChatGPT model catalog and turns', () => {
    it('pages the catalog, marks non-text candidates and recommends the tested default', async () => {
        const connection = await linkedConnection();
        const discovered = await ai.discoverModels(user, connection.id);
        expect(discovered.models.map(model => model.id)).toEqual(['model-alpha', 'model-beta', 'model-vision']);
        expect(discovered.models.find(model => model.id === 'model-vision').candidate).toBe('other');
        expect(discovered.models.find(model => model.id === 'model-beta').is_default).toBe(true);
        const tested = await ai.testModels(user, connection.id, { model_ids: ['model-alpha', 'model-beta'] });
        expect(tested.recommended_model_id).toBe('model-beta');
        expect(tested.models.every(model => model.token_parameter === null)).toBe(true);
    });

    it('records a model that rejects a schema as a JSON fallback and keeps it usable', async () => {
        const connection = await linkedConnection();
        await ai.discoverModels(user, connection.id);
        fake({ rejectStructured: true, recordPath, recordApprovalPath: approvalPath });
        const tested = await ai.testModels(user, connection.id, { model_ids: ['model-beta'] });
        // Plain JSON passed, only the schema-constrained turn failed.
        expect(tested.models[0]).toMatchObject({ chat: true, structured: false, status: 'json_fallback' });
        expect(tested.recommended_model_id).toBe('model-beta');
        ai.saveConnection(user, { model_id: 'model-beta' }, connection.id);
        ai.savePreferences(user, { model_id: 'model-beta' });
        // A stored fallback profile has to keep working for real requests.
        const result = await ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema });
        expect(result.data).toEqual({ ok: true });
    }, 30000);

    it('completes a bounded turn and records the reported token usage', async () => {
        await withModel();
        const result = await ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'check' }], schema });
        expect(result.data).toEqual({ ok: true });
        expect(result.model).toBe('model-beta');
        expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 4 });
        const usage = db.prepare("SELECT status,prompt_tokens FROM ai_usage WHERE feature='search'").get();
        expect(usage).toMatchObject({ status: 'completed', prompt_tokens: 7 });
    });

    it.each([
        ['it streams past the response safety limit', { deltaChunks: 600, deltaSize: 1024, turnDelayMs: 10 }],
        ['the reported output tokens exceed it', { outputTokens: 5000, turnDelayMs: 10 }]
    ])('interrupts a turn when %s', async (_label, overrides) => {
        await withModel();
        fake({ ...overrides, recordPath, recordApprovalPath: approvalPath });
        // The protocol has no per-turn ceiling, so an unbounded answer would burn
        // quota until the deadline and only then be rejected.
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_RESPONSE_TOO_LARGE' });
    }, 30000);

    it('discards a turn that produced a tool action', async () => {
        await withModel();
        fake({ turn: 'toolItem', recordPath, recordApprovalPath: approvalPath });
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_TOOL_REQUEST' });
    });

    it('declines an approval request instead of granting it and discards the turn', async () => {
        await withModel();
        fake({ turn: 'approvalRequest', recordPath, recordApprovalPath: approvalPath });
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_TOOL_REQUEST' });
        const decision = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
        expect(decision).toEqual({ decision: 'cancel' });
    });

    it('refuses a weaker effective policy than the one requested', async () => {
        await withModel();
        for (const override of [{ approvalPolicy: 'never' }, { sandboxEcho: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
            { instructionSources: ['/etc/agents.md'] }]) {
            fake({ ...override, recordPath, recordApprovalPath: approvalPath });
            await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
                .rejects.toMatchObject({ code: 'AI_CODEX_POLICY_MISMATCH' });
        }
    });

    it('rejects malformed, truncated and empty answers while keeping the token record', async () => {
        await withModel();
        for (const answer of ['{"ok":', 'not json at all', '{"ok":"yes"}', null]) {
            fake({ answer, recordPath, recordApprovalPath: approvalPath });
            await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
                .rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
        }
        const failures = db.prepare("SELECT status,prompt_tokens FROM ai_usage WHERE feature='search'").all();
        expect(failures.length).toBe(4);
        expect(failures.every(row => row.status === 'failed' && row.prompt_tokens === 7)).toBe(true);
    });

    it('maps a plan limit to the shared rate-limit error without changing provider or account', async () => {
        const connection = await withModel();
        fake({ turn: 'failed', errorInfo: 'usageLimitExceeded', recordPath, recordApprovalPath: approvalPath });
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_RATE_LIMIT' });
        const after = ai.listConnections(user).find(item => item.id === connection.id);
        expect(after.provider).toBe('chatgpt_account');
        expect(after.model_id).toBe('model-beta');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
    });

    it('refuses to run when an unexpected authentication mode is active', async () => {
        await withModel();
        fake({ authMethod: 'apikey', recordPath, recordApprovalPath: approvalPath });
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_UNEXPECTED_AUTH' });
    });

    it('reports quota only where the interface supplies it', async () => {
        const connection = await linkedConnection();
        const state = await account.readAccountState(user, ownedRecord(user, connection.id));
        expect(state.quota).toMatchObject({ known: true, primary: { used_percent: 42.5, window_minutes: 300, resets_at: 1800000000 } });
        expect(state.quota.price).toBeUndefined();
        fake({ quota: 'unknown' });
        const unknown = await account.readAccountState(user, ownedRecord(user, connection.id));
        expect(unknown.quota).toEqual({ known: false });
    });
});

describe('personal ChatGPT feature contracts', () => {
    // The real answer contract of each of the eight functions, not a minimal
    // `ok:true` object: a valid answer must pass local validation and an answer
    // carrying an action the function does not allow must be rejected.
    const ALL_ACTIONS = {
        create_category: { type: 'create_category', key: 'k1', name: 'Sports', category_type: 'live' },
        rename_category: { type: 'rename_category', category_id: 4, value: 'Sports HD' },
        assign_channel: { type: 'assign_channel', provider_channel_id: 5, category_key: 'k1' },
        rename_channel: { type: 'rename_channel', user_channel_id: 7, value: 'Sport 1' },
        hide_channel: { type: 'hide_channel', user_channel_id: 8, value: true },
        reorder_channel: { type: 'reorder_channel', user_channel_id: 7, value: 3 },
        epg_mapping: { type: 'epg_mapping', provider_channel_id: 5, epg_channel_id: 'sport.1', source_type: 'provider', source_id: 2 }
    };
    const proposal = (...types) => ({ summary: 'Proposed changes for review.', actions: types.map(type => ALL_ACTIONS[type]) });
    const filters = { query: 'news', type: 'live', genre: null, language: null, region: null, start: null, end: null, max_duration: null, interests: null };
    const CONTRACTS = {
        list: [proposal('create_category', 'assign_channel', 'rename_channel', 'hide_channel', 'reorder_channel'), proposal('epg_mapping')],
        cleanup: [proposal('rename_category', 'rename_channel', 'hide_channel', 'reorder_channel'), proposal('assign_channel')],
        duplicates: [proposal('hide_channel'), proposal('rename_channel')],
        epg: [proposal('epg_mapping'), proposal('hide_channel')],
        sync: [proposal('create_category', 'assign_channel', 'rename_channel'), proposal('hide_channel')],
        search: [{ summary: 'Filtered the catalog.', filters, clear_filters: ['genre'] }, { summary: 'x', filters: { query: 'news' }, clear_filters: [] }],
        diagnose: [{ summary: 'Observed local findings only.' }, { summary: 'x', extra: true }],
        text: [{ text: 'A shortened description.', tags: ['news'] }, { text: 'A shortened description.' }]
    };

    it('accepts the real answer of every function and rejects one outside its contract', async () => {
        const { featureResultSchema } = await import('../src/services/ai/features.js');
        const connection = createConnection(user, { functions: Object.keys(CONTRACTS) });
        // `createConnection` applies the narrow default policy; widen it afterwards.
        ai.updateAiSettings(admin, { enabled: true, allow_own_connections: true, allowed_user_ids: [1, 2], functions: Object.keys(CONTRACTS), internal_targets: [] });
        await link(user, connection);
        await ai.discoverModels(user, connection.id);
        await ai.testModels(user, connection.id, { model_ids: ['model-beta'] });
        ai.saveConnection(user, { model_id: 'model-beta', functions: Object.keys(CONTRACTS) }, connection.id);
        ai.savePreferences(user, { model_id: 'model-beta' });
        for (const [feature, [valid, invalid]] of Object.entries(CONTRACTS)) {
            const schema = featureResultSchema(feature);
            fake({ answer: JSON.stringify(valid), recordPath, recordApprovalPath: approvalPath });
            const accepted = await ai.runInference(user, feature, { messages: [{ role: 'user', content: 'x' }], schema });
            expect(accepted.data).toEqual(valid);
            fake({ answer: JSON.stringify(invalid), recordPath, recordApprovalPath: approvalPath });
            await expect(ai.runInference(user, feature, { messages: [{ role: 'user', content: 'x' }], schema }))
                .rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
        }
    }, 60000);
});

describe('personal ChatGPT runtime ownership', () => {
    it('allows only one runtime per identity and connection', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            await expect(runtime.startRuntime('user:1', connection.id)).rejects.toMatchObject({ code: 'AI_BUSY' });
            await expect(ai.discoverModels(user, connection.id)).rejects.toMatchObject({ code: 'AI_BUSY' });
        } finally { runtime.stopRuntime(session); }
        await idleRuntimes();
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        await expect(ai.discoverModels(user, connection.id)).resolves.toBeTruthy();
    });

    it('treats a lost worker as an interrupted sign-in rather than a completed one', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        // Simulate this worker losing the attempt without a terminal notification.
        account.releaseAllAttempts();
        const state = account.readLoginStatus(user, ownedRecord(user, connection.id), started.id, 'fp');
        expect(['failed']).toContain(state.status);
        expect(state.error_code).toMatch(/interrupted/);
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    });

    it('disconnects locally even when the remote sign-out fails', async () => {
        const connection = await withModel();
        const queued = jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'disconnect-key-1');
        fake({ logout: 'fail', recordPath, recordApprovalPath: approvalPath });
        const result = await account.disconnectAccount(user, ownedRecord(user, connection.id));
        expect(result).toEqual({ disconnected: true, remote_logout: false });
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).root)).toBe(false);
        expect(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(queued.id).status).not.toBe('queued');
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_NOT_LINKED' });
    });

    it('never lets a cancelled sign-in overwrite the stored credential', async () => {
        const connection = await linkedConnection();
        const before = credentials.readCredentialRecord('user:1', connection.id);
        // A second sign-in on an already linked connection, cancelled after Codex
        // wrote its new credential file.
        fake({ login: 'success', loginDelayMs: 100, email: 'someone.else@example.org' });
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        await until(() => fs.existsSync(credentials.identityPaths('user:1', connection.id).authFile));
        await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
        const after = credentials.readCredentialRecord('user:1', connection.id);
        // The stored token must not be replaced while its fingerprint and label
        // still describe the previously linked account.
        expect(after.version).toBe(before.version);
        expect(after.encrypted_blob).toBe(before.encrypted_blob);
        expect(after.account_hash).toBe(before.account_hash);
        expect(after.account_label).toBe(before.account_label);
    }, 30000);

    it('never seals when a sign-in runtime crashes on an already linked connection', async () => {
        const connection = await linkedConnection();
        const before = credentials.readCredentialRecord('user:1', connection.id);
        // A second sign-in writes its own credential file, then the child dies
        // before any completion notification.
        fake({ login: 'success', loginDelayMs: 60, exitAfterLogin: true, exitAfterLoginMs: 400, email: 'someone.else@example.org' });
        try { await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'); } catch { /* the crash may surface here */ }
        await until(() => !runtime.liveRuntime('user:1', connection.id), 15000);
        const after = credentials.readCredentialRecord('user:1', connection.id);
        // The unadopted token must not replace the stored one behind the old
        // fingerprint and label.
        expect(after.version).toBe(before.version);
        expect(after.encrypted_blob).toBe(before.encrypted_blob);
        expect(after.account_hash).toBe(before.account_hash);
    }, 30000);

    it('does not delete the files of a runtime that starts while cleanup runs', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            // The runtime holds the lease, so cleanup cannot claim it and must
            // leave its hydrated credential and work directory intact.
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
            expect(credentials.sweepOrphans().cleared).toBe(0);
            expect(credentials.releaseWorkerRuntimes(999999)).toMatchObject({ cleared: 0 });
            expect(fs.existsSync(session.paths.authFile)).toBe(true);
            expect(fs.existsSync(session.paths.workDir)).toBe(true);
        } finally { runtime.stopRuntime(session); }
        await idleRuntimes();
        // Cleanup releases its own lease again, so the next start is not blocked.
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        const next = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(next);
    }, 30000);

    it('holds the lease until the child has actually exited', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        const pid = session.client.pid;
        runtime.stopRuntime(session);
        // Closing only sends SIGTERM. Releasing the lease here would let a
        // replacement start beside a process that is still running.
        expect(runtime.runtimeState('user:1', connection.id)).toMatchObject({ state: 'stopping' });
        await session.client.exited;
        await until(() => runtime.runtimeState('user:1', connection.id) === null, 8000);
        // The child is really gone by the time the identity is free again.
        expect(() => process.kill(pid, 0)).toThrow();
    }, 30000);

    it('keeps the lease until a child that ignores SIGTERM is gone', async () => {
        fake({ ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(session);
        // The child survives SIGTERM, so the identity must stay claimed.
        expect(runtime.runtimeState('user:1', connection.id)).toMatchObject({ state: 'stopping' });
        await until(() => runtime.runtimeState('user:1', connection.id) === null, 10000);
        expect(fs.existsSync(session.paths.authFile)).toBe(false);
    }, 30000);

    it('keeps the lease when the handshake fails and the child lingers', async () => {
        const connection = await linkedConnection();
        // Reconfigured only now, so the link above still succeeds.
        fake({ ignoreTerm: true, reportedHome: '/home/someone-else/.codex', recordPath, recordApprovalPath: approvalPath });
        await expect(runtime.startRuntime('user:1', connection.id)).rejects.toMatchObject({ code: 'AI_CODEX_HOME_MISMATCH' });
        // A failed start still leaves a running child; a retry must not get the
        // identity while it lives.
        expect(runtime.runtimeState('user:1', connection.id)).toMatchObject({ state: 'stopping' });
        await until(() => runtime.runtimeState('user:1', connection.id) === null, 10000);
    }, 30000);

    it('waits for a session that was already stopping when shutdown began', async () => {
        fake({ ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        // Stopping removes it from the live map while its child is still alive.
        runtime.stopRuntime(session);
        expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
        expect(fs.existsSync(session.paths.authFile)).toBe(true);
        await runtime.shutdownRuntimes({ timeoutMs: 10000 });
        // A shutdown that only looked at live runtimes would leave this behind.
        expect(fs.existsSync(session.paths.authFile)).toBe(false);
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
    }, 30000);

    it('does not clean up an identity it no longer holds', async () => {
        fake({ ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(session);
        // The identity is force-released and taken over while the old child is
        // still terminating, exactly as a disconnect that timed out leaves it.
        db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key='user:1' AND connection_id=?").run(connection.id);
        await seedLease(connection.id, 'replacement-lease');
        fs.mkdirSync(session.paths.codexHome, { recursive: true });
        fs.writeFileSync(session.paths.authFile, JSON.stringify({ tokens: { access_token: 'replacement-token' } }), { mode: 0o600 });
        await session.client.exited;
        await new Promise(resolve => { const timer = setTimeout(resolve, 200); timer.unref?.(); });
        // The departing child must leave the new holder's files alone.
        expect(fs.existsSync(session.paths.authFile)).toBe(true);
        expect(runtime.runtimeState('user:1', connection.id)).toMatchObject({ state: 'running' });
        db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key='user:1' AND connection_id=?").run(connection.id);
    }, 30000);

    it('never lets a departing child remove the files of its replacement', async () => {
        fake({ ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const first = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(first);
        // A relink takes the identity while the old child is still terminating.
        db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key='user:1' AND connection_id=?").run(connection.id);
        fake({ recordPath, recordApprovalPath: approvalPath });
        const second = await runtime.startRuntime('user:1', connection.id);
        try {
            await first.client.exited;
            await new Promise(resolve => { const timer = setTimeout(resolve, 200); timer.unref?.(); });
            // The old child's pending cleanup must not touch the new runtime.
            expect(fs.existsSync(second.paths.authFile)).toBe(true);
            expect(runtime.runtimeState('user:1', connection.id)).toBeTruthy();
        } finally { runtime.stopRuntime(second); }
    }, 30000);

    it('waits for children and their credential files during shutdown', async () => {
        fake({ ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        expect(fs.existsSync(session.paths.authFile)).toBe(true);
        // Re-raising a shutdown signal before this resolves would leave the
        // hydrated credential on disk while the service is offline.
        await runtime.shutdownRuntimes({ timeoutMs: 10000 });
        expect(fs.existsSync(session.paths.authFile)).toBe(false);
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
    }, 30000);

    it('lets a replacement wait for a terminating runtime but refuses a live one', async () => {
        const connection = await linkedConnection();
        const first = await runtime.startRuntime('user:1', connection.id);
        // A live runtime is a genuine conflict and is refused at once.
        const started = Date.now();
        await expect(runtime.startRuntime('user:1', connection.id)).rejects.toMatchObject({ code: 'AI_BUSY' });
        expect(Date.now() - started).toBeLessThan(2000);
        // A terminating one is waited for instead.
        runtime.stopRuntime(first);
        const replacement = await runtime.startRuntime('user:1', connection.id);
        runtime.stopRuntime(replacement);
    }, 30000);

    it.each([
        ['the account was deactivated', async connectionId => { void connectionId; db.prepare('UPDATE users SET is_active=0 WHERE id=1').run(); }],
        ['Web UI access was revoked', async connectionId => { void connectionId; db.prepare('UPDATE users SET webui_access=0 WHERE id=1').run(); }],
        ['the account expired', async connectionId => { void connectionId; db.prepare('UPDATE users SET expiry_date=? WHERE id=1').run(Math.floor(Date.now() / 1000) - 60); }],
        ['the connection is tearing down', async connectionId => { ai.adjustConnectionTeardown('user:1', connectionId, 1); }],
        ['the connection is gone', async connectionId => { db.prepare('DELETE FROM ai_connections WHERE id=?').run(connectionId); }]
    ])('refuses a lease to a pre-authorized request once %s', async (_label, revoke) => {
        const connection = await linkedConnection();
        await revoke(connection.id);
        // Granting the lease is the last point at which such a request can be
        // stopped; it passed its own authorization long before.
        await expect(runtime.startRuntime('user:1', connection.id)).rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        db.prepare('UPDATE users SET is_active=1, webui_access=1, expiry_date=NULL WHERE id=1').run();
    }, 30000);

    it('refuses a session whose lease was taken while it was starting', async () => {
        const connection = await linkedConnection();
        // The handshake can outlast a revocation's wait, after which the unlink
        // has already forced the lease away and wiped the credential.
        const stealing = setInterval(() => {
            const row = db.prepare('SELECT state FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get('user:1', connection.id);
            if (row?.state === 'starting') {
                db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key='user:1' AND connection_id=?").run(connection.id);
                clearInterval(stealing);
            }
        }, 5);
        stealing.unref?.();
        try {
            await expect(runtime.startRuntime('user:1', connection.id)).rejects.toMatchObject({ code: 'AI_CODEX_LEASE_LOST' });
        } finally { clearInterval(stealing); }
        // The runtime it started is torn down rather than handed to its caller.
        expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
    }, 30000);

    it('accepts an answer that is large in bytes but within the token budget', async () => {
        await withModel();
        // Four bytes per token is not an upper bound; a byte surrogate derived
        // from the token budget would reject this well below the promised limit.
        const wide = 'Ω'.repeat(6000);
        fake({ answer: JSON.stringify({ ok: true, note: wide }), outputTokens: 100, recordPath, recordApprovalPath: approvalPath });
        const wideSchema = { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string', maxLength: 20000 } }, required: ['ok', 'note'], additionalProperties: false };
        const result = await ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema: wideSchema });
        expect(result.data.note.length).toBe(6000);
    }, 30000);

    it.each([
        ['the server policy is switched off', () => ai.updateAiSettings(admin, { enabled: false })],
        ['the owner loses their allowance', () => ai.updateAiSettings(admin, { allowed_user_ids: [2] })],
        ['the owner turns their own AI off', () => ai.savePreferences(user, { enabled: false })]
    ])('refuses an account runtime once %s', async (_label, revoke) => {
        const connection = await linkedConnection();
        revoke();
        // The request was authorized before this; the lease is the last gate, so
        // the current policy has to be evaluated there too.
        await expect(account.readAccountState(user, ai.ownedAccountConnection(user, connection.id, { requirePolicy: false })))
            .rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        await expect(account.startAccountLink(user, ai.ownedAccountConnection(user, connection.id, { requirePolicy: false }), 'fp'))
            .rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
    }, 30000);

    it('refuses an account runtime after the caller\'s session was revoked', async () => {
        // The version the browser was authenticated with. A password reset
        // advances the stored one, which authentication treats as a revoked
        // session.
        const authenticated = { id: 1, is_admin: false, token_version: 0 };
        const connection = await linkedConnection(authenticated);
        const handle = ai.ownedAccountConnection(authenticated, connection.id, { requirePolicy: false });
        db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=1').run();
        // The lease is the last gate before a personal credential is used, so a
        // request authorized before the reset must not be handed a runtime.
        await expect(account.readAccountState(authenticated, handle))
            .rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        await expect(account.startAccountLink(authenticated, handle, 'fp'))
            .rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        // And the shared access check refuses the revoked session outright.
        await expect(ai.runInference(authenticated, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_FORBIDDEN' });
    }, 30000);

    it('still grants a lease to the teardown that owns the marker', async () => {
        const connection = await linkedConnection();
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        const session = await runtime.startRuntime('user:1', connection.id, { allowTeardown: true });
        runtime.stopRuntime(session);
        await idleRuntimes();
        ai.adjustConnectionTeardown('user:1', connection.id, -1);
    }, 30000);

    it('never refreshes a lease another worker has revoked', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            // The revocation stays visible: a heartbeat that wrote `running` back
            // would swallow it, and the revoking request would wait for an
            // acknowledgement that never arrives.
            db.prepare("UPDATE ai_codex_runtimes SET state='revoked', updated_at=? WHERE owner_key=? AND connection_id=?")
                .run(Date.now(), 'user:1', connection.id);
            await until(() => session.stopped, 8000);
            await idleRuntimes();
            expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        } finally { runtime.stopRuntime(session); }
    }, 30000);

    it('stops a runtime whose lease was revoked by another worker', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            // Exactly what a disconnect handled elsewhere leaves behind.
            db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').run('user:1', connection.id);
            await until(() => session.client.closed || session.stopped, 8000);
            expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
        } finally { runtime.stopRuntime(session); }
    }, 30000);

    it('blocks new work for the whole unlink, not only until its scan', async () => {
        const connection = await withModel();
        // The teardown marker has to be visible to other requests while the
        // unlink runs, or one can take the lease right after its scan.
        let observed = null;
        fake({ logout: 'fail', recordPath, recordApprovalPath: approvalPath });
        const disconnecting = account.disconnectAccount(user, ownedRecord(user, connection.id, { requirePolicy: false, allowTeardown: true }));
        await until(() => {
            try { ai.requireAiAccess(user, 'search', connection.id); return false; }
            catch (error) { observed = error.code; return error.code === 'AI_CONNECTION_CHANGED'; }
        }, 8000);
        expect(observed).toBe('AI_CONNECTION_CHANGED');
        await disconnecting;
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('keeps the teardown marker while an overlapping teardown is still running', async () => {
        const connection = await linkedConnection();
        const handle = ownedRecord(user, connection.id, { requirePolicy: false, allowTeardown: true });
        // Two teardowns from snapshots that both saw no marker. A boolean would
        // let the first to finish reopen the connection under the second.
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        ai.adjustConnectionTeardown('user:1', connection.id, -1);
        expect(thrown(() => ai.ownedAccountConnection(user, connection.id)).code).toBe('AI_CONNECTION_CHANGED');
        ai.adjustConnectionTeardown('user:1', connection.id, -1);
        expect(() => ai.ownedAccountConnection(user, connection.id)).not.toThrow();
        // Never negative, so an extra release cannot unblock a later teardown.
        expect(ai.adjustConnectionTeardown('user:1', connection.id, -1)).toBe(0);
        void handle;
    }, 30000);

    it('clears a teardown marker abandoned by a crashed process on startup', async () => {
        const connection = await linkedConnection();
        // A process that died between marking and releasing would otherwise leave
        // the connection blocked for good.
        ai.adjustConnectionTeardown('user:1', connection.id, 2);
        expect(thrown(() => ai.ownedAccountConnection(user, connection.id)).code).toBe('AI_CONNECTION_CHANGED');
        expect(ai.clearAbandonedTeardowns()).toBeGreaterThan(0);
        expect(() => ai.ownedAccountConnection(user, connection.id)).not.toThrow();
    }, 30000);

    it('refuses to record a sign-in when a teardown started while it waited', async () => {
        const connection = createConnection();
        // The route already returned this snapshot; the unlink begins while the
        // request waits for the lease hand-off.
        const stale = ownedRecord(user, connection.id);
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        await expect(account.startAccountLink(user, stale, 'fp')).rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        expect(db.prepare('SELECT count(*) AS n FROM ai_codex_logins').get().n).toBe(0);
        ai.adjustConnectionTeardown('user:1', connection.id, -1);
    }, 30000);

    it('stops new work as soon as a deleted account is revoked, before its runtimes are purged', async () => {
        const connection = await withModel();
        const session = await runtime.startRuntime('user:1', connection.id);
        // The controller revokes access first, so nothing new can start during the
        // teardown that follows.
        db.prepare('UPDATE users SET is_active = 0, token_version = token_version + 1 WHERE id = ?').run(1);
        expect(thrown(() => jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'revoked-key-00001')).status).toBe(403);
        await account.stopAccountRuntimes('user:1');
        expect(session.stopped).toBe(true);
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        // Stopping is not removing: a deletion that fails afterwards must not have
        // destroyed the account's link.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeTruthy();
        credentials.purgeIdentity('user:1');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        db.prepare('UPDATE users SET is_active=1 WHERE id=1').run();
    }, 30000);

    it('revokes a runtime that wins the lease after the unlink scan', async () => {
        const connection = await withModel();
        // A request authorized before the marker went up takes the identity right
        // after the teardown scan, exactly as an account refresh would.
        await seedLease(connection.id, 'late-winner');
        let acknowledged = false;
        const owner = setInterval(() => {
            const row = db.prepare('SELECT state FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get('user:1', connection.id);
            if (row?.state === 'revoked') {
                acknowledged = true;
                db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key='user:1' AND connection_id=? AND lease_id='late-winner'").run(connection.id);
                clearInterval(owner);
            }
        }, 50);
        owner.unref?.();
        try {
            const result = await account.disconnectAccount(user, ownedRecord(user, connection.id, { requirePolicy: false, allowTeardown: true }));
            // Losing the race is no reason to wipe underneath the winner: it is
            // revoked, awaited, and the sign-out retried.
            expect(acknowledged).toBe(true);
            expect(result.disconnected).toBe(true);
            expect(result.remote_logout).toBe(true);
        } finally { clearInterval(owner); }
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('refuses an account refresh that a teardown overtook', async () => {
        const connection = await withModel();
        const stale = ownedRecord(user, connection.id, { requirePolicy: false, allowTeardown: true });
        ai.adjustConnectionTeardown('user:1', connection.id, 1);
        // The request was authorized before the teardown began; starting a runtime
        // now would race its wipe.
        await expect(account.readAccountState(user, stale)).rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        ai.adjustConnectionTeardown('user:1', connection.id, -1);
    }, 30000);

    it('clears the teardown marker again when an unlink finishes', async () => {
        const connection = await linkedConnection();
        await account.disconnectAccount(user, ownedRecord(user, connection.id, { requirePolicy: false, allowTeardown: true }));
        // The connection survives an unlink, so it must be usable again.
        const stored = JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id).data_json);
        expect(stored.teardown).toBeUndefined();
        expect(() => ai.ownedAccountConnection(user, connection.id)).not.toThrow();
    }, 30000);

    it('waits for the owning worker to acknowledge a revoked lease before signing out', async () => {
        const connection = await withModel();
        await seedLease(connection.id, 'other-worker');
        // The owner acknowledges by releasing the row it saw marked revoked.
        const acknowledge = setInterval(() => {
            const row = db.prepare('SELECT state FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get('user:1', connection.id);
            if (row?.state === 'revoked') {
                db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id='other-worker'").run('user:1', connection.id);
                clearInterval(acknowledge);
            }
        }, 50);
        acknowledge.unref?.();
        try {
            const result = await account.disconnectAccount(user, ownedRecord(user, connection.id));
            expect(result).toEqual({ disconnected: true, remote_logout: true });
        } finally { clearInterval(acknowledge); }
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_NOT_LINKED' });
    }, 30000);

    it('removes local access without a second runtime when the owner never acknowledges', async () => {
        const connection = await withModel();
        await seedLease(connection.id, 'silent-worker');
        const result = await account.disconnectAccount(user, ownedRecord(user, connection.id));
        // Starting a logout runtime beside a possibly live one is never the
        // answer; local access goes and the difference is reported.
        expect(result).toEqual({ disconnected: true, remote_logout: false });
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('keeps the working link when a replacement sign-in is rejected', async () => {
        const mine = await linkedConnection(user);
        const before = credentials.readCredentialRecord('user:1', mine.id);
        // Another account links the address the replacement will authenticate.
        fake({ email: 'second.tester@example.org' });
        const theirs = createConnection(other);
        expect((await link(other, theirs)).state.status).toBe('completed');
        // The replacement authenticates that same, already linked account.
        fake({ login: 'success', loginDelayMs: 100, email: 'second.tester@example.org' });
        const started = await account.startAccountLink(user, ownedRecord(user, mine.id), 'fp');
        await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
        expect(db.prepare('SELECT error_code FROM ai_codex_logins WHERE id=?').get(started.id).error_code)
            .toBe('ai_codex_account_already_linked');
        // A failed replacement must not disconnect the account that worked.
        const after = credentials.readCredentialRecord('user:1', mine.id);
        expect(after).toBeTruthy();
        expect(after.account_hash).toBe(before.account_hash);
        expect(after.encrypted_blob).toBe(before.encrypted_blob);
        expect(fs.existsSync(credentials.identityPaths('user:1', mine.id).authFile)).toBe(false);
    }, 30000);

    it('rejects every kind of work on a connection that is being deleted', async () => {
        const connection = await withModel();
        const raw = JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id).data_json);
        db.prepare('UPDATE ai_connections SET data_json=?, version=version+1 WHERE id=?')
            .run(JSON.stringify({ ...raw, teardown: true }), connection.id);
        // Not only sign-ins: discovery, tests, jobs and inference must not start
        // under a deletion either, or the teardown removes their runtime.
        await expect(ai.discoverModels(user, connection.id)).rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        await expect(ai.testModels(user, connection.id, { model_ids: ['model-beta'] })).rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CONNECTION_CHANGED' });
        expect(thrown(() => jobs.createJob(user, { feature: 'search', prompt: 'x' }, 'deleting-key-0001')).code)
            .toBe('AI_CONNECTION_CHANGED');
    }, 30000);

    it('refuses a new sign-in on a connection that is being deleted', async () => {
        const connection = await linkedConnection();
        // Marked before the teardown, so a sign-in cannot start between the
        // teardown scan and the deletion and be orphaned by it.
        const raw = JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(connection.id).data_json);
        db.prepare('UPDATE ai_connections SET data_json=?, version=version+1 WHERE id=?')
            .run(JSON.stringify({ ...raw, teardown: true }), connection.id);
        expect(thrown(() => ai.ownedAccountConnection(user, connection.id)).code).toBe('AI_CONNECTION_CHANGED');
        // Disconnecting stays reachable so the teardown itself can run.
        expect(ai.ownedAccountConnection(user, connection.id, { requirePolicy: false, allowTeardown: true }).id).toBe(connection.id);
        expect(await ai.removeConnection(user, connection.id)).toEqual({ deleted: true });
        expect(ai.listConnections(user).some(item => item.id === connection.id)).toBe(false);
    }, 30000);

    it('stops a live runtime before deleting an account-linked connection', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        try {
            expect(runtime.runtimeState('user:1', connection.id)).toBeTruthy();
            // Deletion must not return while a runtime is still using the
            // credential the deletion trigger is about to drop.
            expect(await ai.removeConnection(user, connection.id)).toEqual({ deleted: true });
            expect(session.stopped).toBe(true);
            expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
            expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        } finally { runtime.stopRuntime(session); }
        expect(ai.listConnections(user).some(item => item.id === connection.id)).toBe(false);
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).root)).toBe(false);
    }, 30000);

    it('waits for the account-read runtime before invalidating the link', async () => {
        const connection = await withModel();
        fake({ accountRead: 'none', ignoreTerm: true, recordPath, recordApprovalPath: approvalPath });
        await account.readAccountState(user, ownedRecord(user, connection.id));
        // The identity is only free once its child is gone, so a relink cannot
        // start beside it.
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
    }, 30000);

    it('reports an unacknowledged runtime instead of pretending the account stopped', async () => {
        const connection = await linkedConnection();
        await idleRuntimes();
        // A worker that never lets go of the identity. Its child may still be
        // using the credential, so nothing may be removed on that assumption.
        await seedLease(connection.id, 'foreign-worker-lease', { pid: 987654 });
        try {
            expect(await account.stopAccountRuntimes('user:1')).toEqual({ acknowledged: false });
        } finally { db.prepare('DELETE FROM ai_codex_runtimes WHERE connection_id=?').run(connection.id); }
        // And an acknowledged one reports exactly that.
        await idleRuntimes();
        expect(await account.stopAccountRuntimes('user:1')).toEqual({ acknowledged: true });
    }, 30000);

    it('leaves a replacement\'s files alone but still drops the dead record', async () => {
        const connection = await withModel();
        fake({ accountRead: 'none', recordPath, recordApprovalPath: approvalPath });
        // A previous test's child may still be releasing its lease; that release
        // would fire the trigger below before this test's own runtime starts.
        await idleRuntimes();
        // Models the link request that was waiting behind the stopping runtime:
        // the instant the lease row disappears it holds the identity again.
        // Observing that the identity is free is not the same as reserving it.
        db.exec(`CREATE TRIGGER test_relink AFTER DELETE ON ai_codex_runtimes BEGIN
            INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at)
            VALUES(OLD.owner_key, OLD.connection_id, 'replacement', 999999, 'running', ${Date.now() + 600000}, ${Date.now()});
        END;`);
        try {
            const state = await account.readAccountState(user, ownedRecord(user, connection.id));
            expect(state).toMatchObject({ linked: false });
            // Wiping here would have deleted the replacement's own lease and its
            // identity tree underneath a live child, so the files stay.
            expect(db.prepare('SELECT lease_id FROM ai_codex_runtimes WHERE connection_id=?').get(connection.id)?.lease_id).toBe('replacement');
            expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).root)).toBe(true);
            // The record that makes a connection read as linked is dropped while
            // the runtime that found it dead still owns the identity. Losing the
            // reservation must not leave a dead credential looking usable.
            expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
            expect(ai.listConnections(user).find(item => item.id === connection.id).account.linked).toBe(false);
        } finally {
            db.exec('DROP TRIGGER test_relink');
            db.prepare('DELETE FROM ai_codex_runtimes WHERE lease_id=?').run('replacement');
        }
    }, 30000);

    it('refuses a cleanup reservation while the identity is leased', async () => {
        const connection = await withModel();
        await seedLease(connection.id, 'holder');
        try {
            let ran = false;
            expect(credentials.withCleanupLease('user:1', connection.id, () => { ran = true; return true; })).toBeNull();
            expect(ran).toBe(false);
        } finally { db.prepare('DELETE FROM ai_codex_runtimes WHERE lease_id=?').run('holder'); }
    }, 30000);

    it('drops the stored link when a refreshed account read reports none', async () => {
        // A model is selected so the refusal below is the link check, not the
        // model gate in front of it.
        const connection = await withModel();
        fake({ accountRead: 'none', recordPath, recordApprovalPath: approvalPath });
        const state = await account.readAccountState(user, ownedRecord(user, connection.id));
        expect(state).toMatchObject({ linked: false, quota: { known: false } });
        // Keeping the record would show the account as linked again on reload and
        // send the next job at a credential that no longer authenticates.
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(ai.listConnections(user).find(item => item.id === connection.id).account.linked).toBe(false);
        await expect(ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'x' }], schema }))
            .rejects.toMatchObject({ code: 'AI_CODEX_NOT_LINKED' });
    }, 30000);

    it('confirms a successful remote sign-out separately', async () => {
        const connection = await linkedConnection();
        const result = await account.disconnectAccount(user, ownedRecord(user, connection.id));
        expect(result).toEqual({ disconnected: true, remote_logout: true });
    });

    it('keeps another account\'s running sign-in when a user is deleted', async () => {
        fake({ login: 'pending' });
        const mine = createConnection(user);
        const started = await account.startAccountLink(user, ownedRecord(user, mine.id), 'fp');
        const paths = credentials.identityPaths('user:1', mine.id);
        expect(fs.existsSync(paths.codexHome)).toBe(true);
        // An administrator deletes an unrelated account while this sign-in runs.
        credentials.purgeIdentity('user:2');
        expect(fs.existsSync(paths.codexHome)).toBe(true);
        // A sign-in in progress holds no credential record yet, so a sweep must
        // still treat its directory as in use.
        credentials.sweepOrphans();
        expect(fs.existsSync(paths.codexHome)).toBe(true);
        expect(account.readLoginStatus(user, ownedRecord(user, mine.id), started.id, 'fp').status).toBe('pending');
        await account.cancelAccountLink(user, ownedRecord(user, mine.id), started.id);
    });

    it('removes only the deleted account\'s own runtime tree', async () => {
        const mine = await linkedConnection(user);
        fake({ email: 'second.tester@example.org' });
        const theirs = createConnection(other);
        const { state } = await link(other, theirs);
        expect(state.status).toBe('completed');
        const minePaths = credentials.identityPaths('user:1', mine.id);
        const theirPaths = credentials.identityPaths('user:2', theirs.id);
        expect(minePaths.ownerRoot).not.toBe(theirPaths.ownerRoot);
        credentials.purgeIdentity('user:2');
        expect(fs.existsSync(theirPaths.ownerRoot)).toBe(false);
        expect(fs.existsSync(minePaths.root)).toBe(true);
        expect(credentials.readCredentialRecord('user:1', mine.id)).toBeTruthy();
    });

    it('marks sign-ins and runtime leases interrupted on a restart before sweeping', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        expect(runtime.runtimeState('user:1', connection.id)).toBeTruthy();
        // A restart cannot inherit an in-flight attempt or a held lease.
        const reset = credentials.resetInterruptedRuntimes();
        expect(reset.logins).toBe(1);
        expect(reset.leases).toBeGreaterThan(0);
        expect(db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(started.id))
            .toMatchObject({ status: 'failed', error_code: 'ai_codex_login_interrupted' });
        credentials.sweepOrphans();
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).root)).toBe(false);
    });

    it('ends a running runtime before an account deletion returns', async () => {
        const connection = await linkedConnection();
        const session = await runtime.startRuntime('user:1', connection.id);
        expect(runtime.runtimeState('user:1', connection.id)).toBeTruthy();
        // The account's runtime must be stopped and acknowledged before its
        // credential state disappears.
        await account.purgeAccountRuntimes('user:1');
        expect(session.stopped).toBe(true);
        expect(runtime.liveRuntime('user:1', connection.id)).toBeNull();
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
        expect(fs.existsSync(credentials.identityPaths('user:1', connection.id).root)).toBe(false);
    }, 30000);

    it('removes every personal runtime record when the account is deleted', async () => {
        const connection = await linkedConnection();
        const root = credentials.identityPaths('user:1', connection.id).root;
        fs.mkdirSync(root, { recursive: true });
        db.prepare('DELETE FROM users WHERE id=1').run();
        expect(db.prepare('SELECT count(*) AS n FROM ai_codex_credentials').get().n).toBe(0);
        expect(db.prepare('SELECT count(*) AS n FROM ai_codex_logins').get().n).toBe(0);
        credentials.sweepOrphans();
        expect(fs.existsSync(root)).toBe(false);
        db.prepare("INSERT INTO users VALUES (1,'first',1,1,NULL,0)").run();
    });
});
