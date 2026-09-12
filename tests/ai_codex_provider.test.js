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
// environment.
const fakeBinary = path.join(dataDir, 'codex');
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

let db, ai, jobs, account, credentials, readiness, runtime, migrateAiSchema;
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
    await readiness.refreshCodexReadiness({ force: true });
});

afterAll(() => {
    runtime?.stopAllRuntimes();
    account?.releaseAllAttempts();
    db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
});

beforeEach(async () => {
    runtime.stopAllRuntimes();
    account.releaseAllAttempts();
    for (const table of ['ai_connections', 'ai_preferences', 'ai_usage', 'ai_jobs', 'ai_codex_credentials', 'ai_codex_logins', 'ai_codex_runtimes']) db.exec(`DELETE FROM ${table}`);
    db.exec('DELETE FROM settings; UPDATE users SET is_active=1, webui_access=1, token_version=0; UPDATE admin_users SET is_active=1, token_version=0');
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
    await until(() => db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(started.id).status !== 'pending');
    return { started, state: account.readLoginStatus(actor, ownedRecord(actor, connection.id), started.id) };
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

    it('refuses an unpinned Codex release', async () => {
        fake({ version: '0.99.0' });
        readiness.resetCodexReadiness();
        const result = await readiness.refreshCodexReadiness({ force: true });
        expect(result).toMatchObject({ available: false, reason: 'AI_CODEX_VERSION_UNSUPPORTED' });
    });

    it('refuses a runtime that reports a different protocol version than the pinned binary', async () => {
        fake({ reportedVersion: '0.140.0' });
        const connection = createConnection();
        await expect(account.startAccountLink(user, ownedRecord(user, connection.id), 'fp'))
            .rejects.toMatchObject({ code: 'AI_CODEX_VERSION_UNSUPPORTED' });
    });

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

    it('cancels a pending sign-in and stores nothing', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        const cancelled = await account.cancelAccountLink(user, ownedRecord(user, connection.id), started.id);
        expect(cancelled.status).toBe('cancelled');
        expect(credentials.readCredentialRecord('user:1', connection.id)).toBeNull();
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
        expect(account.readLoginStatus(user, ownedRecord(user, connection.id), second.id).status).toBe('pending');
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

    it('completes a bounded turn and records the reported token usage', async () => {
        await withModel();
        const result = await ai.runInference(user, 'search', { messages: [{ role: 'user', content: 'check' }], schema });
        expect(result.data).toEqual({ ok: true });
        expect(result.model).toBe('model-beta');
        expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 4 });
        const usage = db.prepare("SELECT status,prompt_tokens FROM ai_usage WHERE feature='search'").get();
        expect(usage).toMatchObject({ status: 'completed', prompt_tokens: 7 });
    });

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
        expect(runtime.runtimeState('user:1', connection.id)).toBeNull();
        await expect(ai.discoverModels(user, connection.id)).resolves.toBeTruthy();
    });

    it('treats a lost worker as an interrupted sign-in rather than a completed one', async () => {
        fake({ login: 'pending' });
        const connection = createConnection();
        const started = await account.startAccountLink(user, ownedRecord(user, connection.id), 'fp');
        // Simulate this worker losing the attempt without a terminal notification.
        account.releaseAllAttempts();
        const state = account.readLoginStatus(user, ownedRecord(user, connection.id), started.id);
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

    it('confirms a successful remote sign-out separately', async () => {
        const connection = await linkedConnection();
        const result = await account.disconnectAccount(user, ownedRecord(user, connection.id));
        expect(result).toEqual({ disconnected: true, remote_logout: true });
    });

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
