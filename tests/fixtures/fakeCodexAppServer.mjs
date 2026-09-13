#!/usr/bin/env node
// Synthetic stand-in for `codex app-server`. It speaks the same newline-delimited
// JSON-RPC protocol as the pinned release so the manager's real client, runtime,
// credential store and provider adapter are exercised end to end. It never
// contacts OpenAI and holds no credential of any kind.
import fs from 'node:fs';
import path from 'node:path';

const configPath = process.env.FAKE_CODEX_CONFIG;
const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
};
const config = readConfig();
const version = config.version || '0.154.0';

if (process.argv.includes('--version')) {
    process.stdout.write(`codex-cli ${version}\n`);
    process.exit(0);
}

// Record the exact arguments and environment the manager launched us with, so a
// test can assert the hardened flag set and a sanitized environment.
if (config.recordPath) {
    fs.writeFileSync(config.recordPath, JSON.stringify({
        argv: process.argv.slice(2),
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FAKE_CODEX_')))
    }));
}

// Models a runtime whose configuration is rejected: it exits between spawn and
// the client's first write, so the pipe reports EPIPE asynchronously.
if (config.exitOnStart) process.exit(config.exitCode ?? 1);

// Models a child that does not die on SIGTERM, so a caller has to wait for the
// protocol client's escalation to SIGKILL.
if (config.ignoreTerm) process.on('SIGTERM', () => {});

// Models a child that takes a moment to shut down and records that it really
// exited, so a test can tell whether a caller waited for the hand-off. Both
// endings are covered: a closed stdin, which is how the manager stops a runtime,
// and a SIGTERM.
function shutdown() {
    const finish = () => {
        try { if (config.exitRecordPath) fs.writeFileSync(config.exitRecordPath, 'exited'); } catch { /* the directory may be gone */ }
        process.exit(0);
    };
    if (config.slowExitMs) setTimeout(finish, config.slowExitMs);
    else finish();
}
if (config.exitRecordPath && !config.ignoreTerm) process.on('SIGTERM', shutdown);

const codexHome = process.env.CODEX_HOME || '';
const authFile = path.join(codexHome, 'auth.json');
const hasAuth = () => fs.existsSync(authFile);
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const later = (ms, run) => { const timer = setTimeout(run, ms); timer.unref?.(); };

let pendingLoginId = null;

function authStatus() {
    if (config.authMethod === 'apikey') return 'apikey';
    return hasAuth() ? 'chatgpt' : null;
}

function accountPayload() {
    if (authStatus() !== 'chatgpt') return null;
    // `emailNull` models an account the interface reports without an address.
    return { type: 'chatgpt', email: config.emailNull ? null : (config.email || 'pilot.tester@example.org'), planType: config.planType || 'plus' };
}

function modelPage(params) {
    const catalog = config.models || [
        { id: 'model-alpha', displayName: 'Alpha', isDefault: false, inputModalities: ['text'] },
        { id: 'model-beta', displayName: 'Beta', isDefault: true, inputModalities: ['text'] },
        { id: 'model-vision', displayName: 'Vision', isDefault: false, inputModalities: ['image'] }
    ];
    const size = Math.max(1, Math.min(Number(params?.limit) || 2, 100));
    const start = Number(params?.cursor || 0);
    const slice = catalog.slice(start, start + size);
    const next = start + size < catalog.length ? String(start + size) : null;
    return { data: slice, nextCursor: next };
}

function completeTurn(threadId, turnId) {
    const mode = config.turn || 'ok';
    if (mode === 'toolItem') {
        notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'x1', command: 'ls', cwd: codexHome, status: 'completed' } });
    }
    if (mode === 'approvalRequest') {
        // A real runtime asks the client to approve; the manager must decline and
        // discard the turn.
        send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'x1', command: 'ls' } });
        return;
    }
    if (mode === 'stall') return;
    // Streams more output than the caller's budget allows.
    if (config.deltaChunks) {
        for (let index = 0; index < config.deltaChunks; index += 1) {
            notify('item/agentMessage/delta', { threadId, turnId, itemId: 'm1', delta: 'x'.repeat(config.deltaSize ?? 1024) });
        }
    }
    if (config.outputTokens) {
        notify('thread/tokenUsage/updated', { threadId, turnId,
            tokenUsage: { total: { totalTokens: config.outputTokens, inputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: config.outputTokens, reasoningOutputTokens: 0 }, last: {}, modelContextWindow: null } });
    }
    notify('thread/tokenUsage/updated', {
        threadId, turnId,
        tokenUsage: { total: { totalTokens: 11, inputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 }, last: {}, modelContextWindow: null }
    });
    if (mode === 'failed') {
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'complete', status: 'failed', error: { message: 'limit', codexErrorInfo: config.errorInfo || 'usageLimitExceeded', additionalDetails: null, misalignment: null } } });
        return;
    }
    if (mode === 'interrupted') {
        notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'complete', status: 'interrupted', error: null } });
        return;
    }
    const text = Object.hasOwn(config, 'answer') ? config.answer : '{"ok":true}';
    const items = text === null ? [] : [{ type: 'agentMessage', id: 'm1', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }];
    for (const item of items) notify('item/completed', { threadId, turnId, item, completedAtMs: Date.now() });
    notify('turn/completed', { threadId, turn: { id: turnId, items, itemsView: 'complete', status: 'completed', error: null } });
}

function handle(message) {
    const { id, method, params } = message;
    const reply = result => send({ id, result });
    const failure = text => send({ id, error: { code: -32600, message: text } });
    switch (method) {
        case 'initialize':
            return reply({
                userAgent: `iptv-manager/${config.reportedVersion || version} (Test OS; arm64) unknown (iptv-manager; 1.0.0)`,
                codexHome: config.reportedHome || codexHome,
                platformFamily: 'unix',
                platformOs: 'linux'
            });
        case 'getAuthStatus':
            return reply({ authMethod: authStatus(), authToken: null, requiresOpenaiAuth: true });
        case 'account/read':
            // `none` models a stored credential that no longer authenticates an
            // account even though the auth mode still reads as ChatGPT.
            return reply({ account: config.accountRead === 'none' ? null : accountPayload(), requiresOpenaiAuth: true });
        case 'account/login/start': {
            if (config.login === 'unsupported') return failure('device code login is not enabled');
            pendingLoginId = config.loginId || 'login-1';
            const response = {
                type: 'chatgptDeviceCode',
                loginId: pendingLoginId,
                verificationUrl: config.verificationUrl || 'https://auth.openai.com/codex/device',
                userCode: config.userCode || 'ABCD-1234'
            };
            reply(response);
            // Models a runtime that dies after handing out the device code and
            // before any completion notification.
            if (config.exitAfterLogin) { later(config.exitAfterLoginMs ?? 40, () => process.exit(1)); return undefined; }
            const outcome = config.login || 'success';
            if (outcome === 'pending') return undefined;
            const succeed = loginId => {
                fs.mkdirSync(codexHome, { recursive: true });
                fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: 'synthetic-access-token' } }), { mode: 0o600 });
                notify('account/login/completed', { loginId, success: true, error: null, onboardingEntrypoint: null });
            };
            const delay = config.loginDelayMs ?? 30;
            // A completion naming another login arrives first; the real one must
            // still be processed afterwards.
            if (outcome === 'mismatchThenSuccess') {
                later(delay, () => notify('account/login/completed', { loginId: 'someone-elses-login', success: true, error: null, onboardingEntrypoint: null }));
                later(delay + (config.secondLoginDelayMs ?? 250), () => succeed(pendingLoginId));
                return undefined;
            }
            later(delay, () => {
                if (outcome === 'success') return succeed(config.completedLoginId || pendingLoginId);
                notify('account/login/completed', {
                    loginId: config.completedLoginId || pendingLoginId,
                    success: false,
                    error: 'declined',
                    onboardingEntrypoint: null
                });
            });
            return undefined;
        }
        case 'account/login/cancel':
            return reply({ status: params?.loginId && params.loginId === pendingLoginId ? 'canceled' : 'notFound' });
        case 'account/logout':
            if (config.logout === 'fail') return failure('logout unavailable');
            fs.rmSync(authFile, { force: true });
            return reply({});
        case 'account/rateLimits/read':
            if (authStatus() !== 'chatgpt') return failure('codex account authentication required to read rate limits');
            if (config.quota === 'unknown') return reply({ ordinaryUsageAllowed: null, rateLimits: {}, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null });
            return reply({
                ordinaryUsageAllowed: true,
                rateLimits: { limitId: 'codex', limitName: 'Codex', normalModelSlug: null, planType: 'plus', rateLimitReachedType: null,
                    primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null },
                rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: 'acct-1', rateLimitUpsell: null
            });
        case 'model/list':
            if (authStatus() !== 'chatgpt' && config.modelsRequireAuth) return failure('authentication required');
            // A slow catalog: every page answers late, so a caller with one
            // overall budget runs out while a per-page timeout would not.
            if (config.modelDelayMs) { later(config.modelDelayMs, () => reply(modelPage(params))); return undefined; }
            return reply(modelPage(params));
        case 'thread/start': {
            // A slow thread start: long enough for access to change before the
            // billable turn is submitted.
            const started = () => reply({
                thread: { id: 'thread-1', environments: [] },
                model: params?.model || 'model-alpha',
                modelProvider: 'openai',
                serviceTier: null,
                cwd: params?.cwd || codexHome,
                instructionSources: config.instructionSources || [],
                approvalPolicy: config.approvalPolicy || params?.approvalPolicy || 'untrusted',
                approvalsReviewer: 'user',
                sandbox: config.sandboxEcho || { type: 'readOnly', networkAccess: false },
                reasoningEffort: null
            });
            if (config.threadDelayMs) { later(config.threadDelayMs, started); return undefined; }
            return started();
        }
        case 'turn/start': {
            const turnId = 'turn-1';
            // Records that a billable turn was actually submitted.
            if (config.turnRecordPath) { try { fs.writeFileSync(config.turnRecordPath, 'started'); } catch { /* ignored */ } }
            // Models a model that answers plain JSON but rejects a schema.
            if (config.rejectStructured && params?.outputSchema) {
                reply({ turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null } });
                later(config.turnDelayMs ?? 20, () => notify('turn/completed', { threadId: params?.threadId || 'thread-1',
                    turn: { id: turnId, items: [], itemsView: 'complete', status: 'failed',
                        error: { message: 'schema unsupported', codexErrorInfo: 'badRequest', additionalDetails: null, misalignment: null } } }));
                return undefined;
            }
            // A slow acknowledgement of the turn itself, separate from how long
            // the answer then takes.
            const acknowledge = () => reply({ turn: { id: turnId, items: [], itemsView: 'complete', status: 'inProgress', error: null } });
            if (config.turnStartDelayMs) later(config.turnStartDelayMs, acknowledge); else acknowledge();
            later((config.turnStartDelayMs ?? 0) + (config.turnDelayMs ?? 20), () => completeTurn(params?.threadId || 'thread-1', turnId));
            return undefined;
        }
        case 'turn/interrupt':
            return reply({});
        default:
            return failure(`unknown method ${method}`);
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === undefined) continue;
        // A client response to one of our server requests: record and stop.
        if (message.result !== undefined && message.method === undefined && message.id === 9001) {
            if (config.recordApprovalPath) fs.writeFileSync(config.recordApprovalPath, JSON.stringify(message.result));
            continue;
        }
        if (message.error !== undefined && message.method === undefined) continue;
        handle(message);
    }
});
process.stdin.on('end', () => (config.exitRecordPath || config.slowExitMs ? shutdown() : process.exit(0)));
