import { randomUUID } from 'node:crypto';
import db from '../../../database/db.js';
import { codexConfig, versionSupported, DISABLED_CODEX_FEATURES, CODEX_CONFIG_OVERRIDES } from './config.js';
import { resolveIsolation, wrapCommand, codexVersion, resolveCodexBinary } from './isolation.js';
import { createClient, codexError } from './protocol.js';
import { hydrate, seal, clearPlaintext, identityPaths } from './credentials.js';

const LEASE_TTL_MS = 60000;
const HEARTBEAT_MS = 20000;
const HANDSHAKE_TIMEOUT_MS = 20000;
const live = new Map();

const runtimeKey = (ownerKey, connectionId) => `${ownerKey}|${connectionId}`;

// One runtime per identity and connection, owned by exactly one worker. The
// lease makes a concurrent start, a competing credential refresh or the reuse of
// another identity's session impossible across the manager's workers.
function acquireLease(ownerKey, connectionId) {
    const leaseId = randomUUID();
    const acquired = db.transaction(() => {
        const now = Date.now();
        db.prepare('DELETE FROM ai_codex_runtimes WHERE expires_at < ?').run(now);
        const existing = db.prepare('SELECT lease_id,worker_pid FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId);
        if (existing) return null;
        db.prepare('INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(ownerKey, connectionId, leaseId, process.pid, 'starting', now + LEASE_TTL_MS, now);
        return leaseId;
    }).immediate();
    if (!acquired) throw codexError('AI_BUSY', 'A Codex runtime for this connection is already active.', 409);
    return acquired;
}

function refreshLease(ownerKey, connectionId, leaseId, state = 'running') {
    const now = Date.now();
    const updated = db.prepare('UPDATE ai_codex_runtimes SET expires_at=?,updated_at=?,state=? WHERE owner_key=? AND connection_id=? AND lease_id=?')
        .run(now + LEASE_TTL_MS, now, state, ownerKey, connectionId, leaseId);
    return updated.changes > 0;
}

function releaseLease(ownerKey, connectionId, leaseId) {
    db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=?').run(ownerKey, connectionId, leaseId);
}

export function runtimeState(ownerKey, connectionId) {
    const row = db.prepare('SELECT state,worker_pid,expires_at FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND expires_at>=?')
        .get(ownerKey, connectionId, Date.now());
    return row || null;
}

// Reports whether this host can offer the adapter at all. Every failure is a
// stable reason code; nothing here silently downgrades to an unsandboxed or
// unpinned runtime.
export async function codexAvailability({ force = false } = {}) {
    const config = codexConfig();
    if (!config.enabled) return { available: false, reason: 'AI_CODEX_DISABLED' };
    // The same absolute path is probed here and launched later, so a runtime
    // that the probe can reach but the sandbox cannot is impossible.
    const binary = resolveCodexBinary(config.binary);
    if (!binary) return { available: false, reason: 'AI_CODEX_BINARY_MISSING' };
    const version = codexVersion(binary);
    if (!version) return { available: false, reason: 'AI_CODEX_BINARY_MISSING' };
    if (!versionSupported(version) && config.versionOverride !== version) {
        return { available: false, reason: 'AI_CODEX_VERSION_UNSUPPORTED', version };
    }
    const isolation = await resolveIsolation({ force });
    if (!isolation.available) return { available: false, reason: isolation.reason, version, backend: isolation.backend, grade: isolation.grade };
    return { available: true, version, binary, backend: isolation.backend, grade: isolation.grade };
}

function spawnDescription(isolation, paths, binary) {
    const command = [binary, 'app-server', '--listen', 'stdio://', '--strict-config',
        ...DISABLED_CODEX_FEATURES.flatMap(feature => ['--disable', feature]),
        ...CODEX_CONFIG_OVERRIDES.flatMap(override => ['-c', override])];
    return wrapCommand(isolation.handle, { codexHome: paths.codexHome, workDir: paths.workDir, command });
}

async function handshake(client, paths, expectedVersion) {
    const result = await client.request('initialize', {
        clientInfo: { name: 'iptv-manager', title: 'IPTV-Manager', version: '1.0.0' },
        // No experimental surface and no attestation callbacks are accepted.
        capabilities: { experimentalApi: false, requestAttestation: false }
    }, { timeoutMs: HANDSHAKE_TIMEOUT_MS });
    // Proves the sandboxed CODEX_HOME took effect instead of a host profile.
    if (result?.codexHome && ![paths.codexHome, `/private${paths.codexHome}`].includes(result.codexHome)) {
        throw codexError('AI_CODEX_HOME_MISMATCH', 'Codex resolved an unexpected credential directory.');
    }
    const reported = String(result?.userAgent || '').match(/\/(\d+\.\d+\.\d+)/)?.[1] || null;
    if (reported && expectedVersion && reported !== expectedVersion) {
        throw codexError('AI_CODEX_VERSION_UNSUPPORTED', 'Codex reported an unexpected protocol version.');
    }
    client.notify('initialized', {});
    return result;
}

// Any tool, approval or capability request from the runtime is recorded as a
// boundary violation. The caller must discard the entire turn.
function violationSink() {
    const violations = [];
    return {
        violations,
        record(detail) { if (violations.length < 20) violations.push(String(detail?.method || 'unknown').slice(0, 120)); }
    };
}

export async function startRuntime(ownerKey, connectionId, { onNotification } = {}) {
    const availability = await codexAvailability();
    if (!availability.available) throw codexError(availability.reason, 'The personal ChatGPT runtime is unavailable on this host.', 503);
    const isolation = await resolveIsolation();
    const leaseId = acquireLease(ownerKey, connectionId);
    let session = null;
    try {
        const paths = hydrate(ownerKey, connectionId);
        const sink = violationSink();
        const description = spawnDescription(isolation, paths, availability.binary);
        session = { paths, sink, leaseId, ownerKey, connectionId, availability, heartbeat: null, stopped: false, onTurnEvent: null };
        const client = createClient({
            file: description.file,
            args: description.args,
            env: description.environment,
            cwd: undefined,
            onNotification: (method, params) => {
                session.onTurnEvent?.(method, params);
                onNotification?.(method, params);
            },
            onViolation: sink.record
        });
        session.client = client;
        await handshake(client, paths, availability.version);
        session.heartbeat = setInterval(() => {
            if (!refreshLease(ownerKey, connectionId, leaseId)) stopRuntime(session, 'AI_CODEX_LEASE_LOST');
        }, HEARTBEAT_MS);
        session.heartbeat.unref?.();
        installShutdownHandlers();
        live.set(runtimeKey(ownerKey, connectionId), session);
        return session;
    } catch (error) {
        if (session?.client) session.client.close('AI_CODEX_RUNTIME_FAILED');
        releaseLease(ownerKey, connectionId, leaseId);
        clearPlaintext(ownerKey, connectionId);
        throw error;
    }
}

export function stopRuntime(session, reason = 'AI_CODEX_RUNTIME_CLOSED', { keepCredentials = true } = {}) {
    if (!session || session.stopped) return;
    session.stopped = true;
    clearInterval(session.heartbeat);
    // Capture a token the runtime refreshed during this session before the
    // plaintext copy is removed.
    if (keepCredentials) { try { seal(session.ownerKey, session.connectionId, {}, { refreshOnly: true }); } catch { /* sealing is best effort on shutdown */ } }
    session.client.close(reason);
    live.delete(runtimeKey(session.ownerKey, session.connectionId));
    releaseLease(session.ownerKey, session.connectionId, session.leaseId);
    clearPlaintext(session.ownerKey, session.connectionId);
}

export function liveRuntime(ownerKey, connectionId) {
    const session = live.get(runtimeKey(ownerKey, connectionId));
    if (!session || session.stopped || session.client.closed) return null;
    return session;
}

// Runs one bounded operation on a fresh runtime and always tears it down. There
// is no shared process that could be switched between personal logins.
export async function withRuntime(ownerKey, connectionId, handler, { onNotification } = {}) {
    const session = await startRuntime(ownerKey, connectionId, { onNotification });
    try { return await handler(session); }
    finally { stopRuntime(session); }
}

export function stopAllRuntimes(reason = 'AI_CODEX_RUNTIME_CLOSED') {
    for (const session of [...live.values()]) stopRuntime(session, reason);
}

export function identityDirectories(ownerKey, connectionId) { return identityPaths(ownerKey, connectionId); }

// Installed only once a runtime actually exists, so a host with the adapter
// disabled keeps Node's default signal behavior untouched. On a signal the
// handler cleans up, removes itself and re-raises, because a listener that only
// returns would suppress termination and leave the process running through a
// container or service shutdown.
let signalsInstalled = false;
function installShutdownHandlers() {
    if (signalsInstalled) return;
    signalsInstalled = true;
    process.on('exit', () => stopAllRuntimes('AI_CODEX_RUNTIME_CLOSED'));
    for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = () => {
            stopAllRuntimes('AI_CODEX_RUNTIME_CLOSED');
            process.removeListener(signal, handler);
            process.kill(process.pid, signal);
        };
        process.on(signal, handler);
    }
}
