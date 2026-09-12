import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import db from '../../../database/db.js';
import { codexConfig, versionSupported, DISABLED_CODEX_FEATURES, CODEX_CONFIG_OVERRIDES } from './config.js';
import { resolveIsolation, wrapCommand, resolveCodexBinary, unsafeLauncherMounts } from './isolation.js';
import { createClient, codexError } from './protocol.js';
import { hydrate, seal, clearPlaintext, identityPaths } from './credentials.js';

const LEASE_TTL_MS = 60000;
const HEARTBEAT_MS = 20000;
// The lease is checked far more often than it is refreshed, so a revocation
// handled by another worker stops this runtime within a second instead of within
// a heartbeat, while an in-flight billable request is still running.
const GUARD_MS = 1000;
// A lease whose runtime is on its way out is waited for; any other holder is a
// genuine concurrent operation and is refused at once.
const TRANSIENT_STATES = ['stopping', 'revoked', 'cleanup'];
const LEASE_HANDOVER_MS = 5000;
// Long enough to cover the protocol client's own escalation to SIGKILL.
const SHUTDOWN_WAIT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 20000;
const live = new Map();
// A runtime that was told to stop is not live any more, but its child can run for
// a few more seconds. Shutdown has to know about those too, or their credential
// files are left behind.
const terminating = new Set();

const runtimeKey = (ownerKey, connectionId) => `${ownerKey}|${connectionId}`;
const run = promisify(execFile);

// The runtime is execution-capable and may have been replaced, so even asking it
// for its version happens inside the verified sandbox. Running it on the host
// first would hand it the data directory and the key files before any boundary
// exists.
export async function probeCodexVersion(backend, binary, runtimeDir) {
    if (!backend || !binary) return null;
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const probeRoot = fs.mkdtempSync(path.join(runtimeDir, 'version-'));
    const codexHome = path.join(probeRoot, 'home');
    const workDir = path.join(probeRoot, 'work');
    for (const dir of [codexHome, workDir, path.join(workDir, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        const description = wrapCommand(backend, { codexHome, workDir, command: [binary, '--version'], launcher: binary });
        const { stdout } = await run(description.file, description.args,
            { env: description.environment, timeout: 15000, maxBuffer: 64 * 1024 });
        return stdout.trim().match(/(\d+\.\d+\.\d+)/)?.[1] || null;
    } catch { return null; }
    finally { fs.rmSync(probeRoot, { recursive: true, force: true }); }
}

// One runtime per identity and connection, owned by exactly one worker. The
// lease makes a concurrent start, a competing credential refresh or the reuse of
// another identity's session impossible across the manager's workers.
function tryAcquireLease(ownerKey, connectionId) {
    const leaseId = randomUUID();
    return db.transaction(() => {
        const now = Date.now();
        db.prepare('DELETE FROM ai_codex_runtimes WHERE expires_at < ?').run(now);
        const existing = db.prepare('SELECT lease_id,state FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId);
        if (existing) return { leaseId: null, blockedBy: existing.state };
        db.prepare('INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(ownerKey, connectionId, leaseId, process.pid, 'starting', now + LEASE_TTL_MS, now);
        return { leaseId, blockedBy: null };
    }).immediate();
}

// A runtime that is terminating still holds its lease until its child has
// actually exited, so a replacement waits for that hand-off. Anything else
// holding the lease is a concurrent operation and is refused immediately.
async function acquireLease(ownerKey, connectionId) {
    const deadline = Date.now() + LEASE_HANDOVER_MS;
    for (;;) {
        const attempt = tryAcquireLease(ownerKey, connectionId);
        if (attempt.leaseId) return attempt.leaseId;
        if (!TRANSIENT_STATES.includes(attempt.blockedBy) || Date.now() >= deadline) {
            throw codexError('AI_BUSY', 'A Codex runtime for this connection is already active.', 409);
        }
        await new Promise(resolve => { const timer = setTimeout(resolve, 100); timer.unref?.(); });
    }
}

// True while this worker still owns the lease it was granted. A lease another
// worker marked revoked is not held any more: releasing it is this worker's
// acknowledgement that its runtime has actually stopped.
function holdsLease(ownerKey, connectionId, leaseId) {
    const row = db.prepare('SELECT lease_id,state,expires_at FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId);
    return Boolean(row) && row.lease_id === leaseId && row.state !== 'revoked' && row.expires_at >= Date.now();
}

// A refresh must never write a terminal state back to running. Another worker
// can revoke this lease between the ownership check and this update, and
// resurrecting it would swallow that revocation: the revoking request would wait
// for an acknowledgement that never comes, force the lease away and return while
// this child is still alive.
function refreshLease(ownerKey, connectionId, leaseId, state = 'running') {
    const now = Date.now();
    const updated = db.prepare(`UPDATE ai_codex_runtimes SET expires_at=?,updated_at=?,state=?
        WHERE owner_key=? AND connection_id=? AND lease_id=? AND state NOT IN ('revoked','stopping','cleanup')`)
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
    // Mounting a launcher that sits in or above the data directory would hand the
    // runtime the database, the encryption key and every other identity.
    if (unsafeLauncherMounts(binary).length) return { available: false, reason: 'AI_CODEX_BINARY_UNSAFE_LOCATION', binary };
    // The sandbox is resolved first, because even the version probe executes the
    // runtime and must therefore already be contained.
    const isolation = await resolveIsolation({ force });
    if (!isolation.available) return { available: false, reason: isolation.reason, backend: isolation.backend, grade: isolation.grade };
    const version = await probeCodexVersion(isolation.handle, binary, config.runtimeDir);
    if (!version) return { available: false, reason: 'AI_CODEX_BINARY_MISSING' };
    if (!versionSupported(version) && config.versionOverride !== version) {
        return { available: false, reason: 'AI_CODEX_VERSION_UNSUPPORTED', version };
    }
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

// Marks the lease as terminating and frees it only once the child has actually
// exited. Used by every path that ends a runtime, so none of them can hand the
// identity to a replacement while a process is still alive.
function releaseAfterExit(ownerKey, connectionId, leaseId, client) {
    db.prepare("UPDATE ai_codex_runtimes SET state='stopping', updated_at=? WHERE owner_key=? AND connection_id=? AND lease_id=?")
        .run(Date.now(), ownerKey, connectionId, leaseId);
    // Cleanup happens while the lease is still held and in the same immediate
    // transaction that releases it, so it is mutually exclusive with acquisition:
    // a replacement cannot own this identity while its files are being removed.
    // Checking after the release could not achieve that, because acquisition can
    // land between the release and the check, or between the check and the
    // removal.
    const release = () => {
        db.transaction(() => {
            const stillOurs = db.prepare('SELECT 1 FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=?')
                .get(ownerKey, connectionId, leaseId);
            // Someone force-released this identity and it may already belong to
            // another runtime; the sweeps clean up what is left behind.
            if (stillOurs) clearPlaintext(ownerKey, connectionId);
            db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=?')
                .run(ownerKey, connectionId, leaseId);
        }).immediate();
    };
    client.exited.then(release, release);
    return client.exited;
}

function trackTermination(session) {
    terminating.add(session);
    const forget = () => terminating.delete(session);
    session.client.exited.then(forget, forget);
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

export async function startRuntime(ownerKey, connectionId, { onNotification, onClosed, sealOnStop = true } = {}) {
    const availability = await codexAvailability();
    if (!availability.available) throw codexError(availability.reason, 'The personal ChatGPT runtime is unavailable on this host.', 503);
    const isolation = await resolveIsolation();
    const leaseId = await acquireLease(ownerKey, connectionId);
    let session = null;
    try {
        const paths = hydrate(ownerKey, connectionId);
        const sink = violationSink();
        const description = spawnDescription(isolation, paths, availability.binary);
        session = { paths, sink, leaseId, ownerKey, connectionId, availability, heartbeat: null, stopped: false, onTurnEvent: null, sealOnStop };
        const client = createClient({
            file: description.file,
            args: description.args,
            env: description.environment,
            cwd: undefined,
            onNotification: (method, params) => {
                session.onTurnEvent?.(method, params);
                onNotification?.(method, params);
            },
            onViolation: sink.record,
            // A runtime whose child died must not keep its lease alive; whatever
            // was waiting on it is told immediately rather than after a timeout.
            onClose: reason => {
                stopRuntime(session, reason);
                onClosed?.(reason);
            }
        });
        session.client = client;
        await handshake(client, paths, availability.version);
        let refreshedAt = Date.now();
        session.heartbeat = setInterval(() => {
            if (session.client.closed) return stopRuntime(session, session.client.closeReason || 'AI_CODEX_RUNTIME_CLOSED');
            // A disconnect handled by another worker removes the lease. Noticing
            // that quickly is what stops a running request from continuing to use
            // a credential that was just revoked.
            if (!holdsLease(ownerKey, connectionId, leaseId)) return stopRuntime(session, 'AI_CODEX_LEASE_LOST');
            if (Date.now() - refreshedAt < HEARTBEAT_MS) return;
            refreshedAt = Date.now();
            if (!refreshLease(ownerKey, connectionId, leaseId)) stopRuntime(session, 'AI_CODEX_LEASE_LOST');
        }, GUARD_MS);
        session.heartbeat.unref?.();
        installShutdownHandlers();
        live.set(runtimeKey(ownerKey, connectionId), session);
        return session;
    } catch (error) {
        // A handshake that failed still leaves a child that only received
        // SIGTERM, so this path releases the lease on its exit as well.
        if (session?.client) {
            session.client.close('AI_CODEX_RUNTIME_FAILED');
            releaseAfterExit(ownerKey, connectionId, leaseId, session.client);
            trackTermination(session);
        } else {
            releaseLease(ownerKey, connectionId, leaseId);
            clearPlaintext(ownerKey, connectionId);
        }
        throw error;
    }
}

export function stopRuntime(session, reason = 'AI_CODEX_RUNTIME_CLOSED', options = {}) {
    if (!session || session.stopped) return;
    session.stopped = true;
    clearInterval(session.heartbeat);
    // A runtime started for a sign-in never seals, however it ends. Its
    // credential file belongs to an account that has not been adopted, and a
    // refresh-only seal would let it replace an existing one while keeping the
    // previous account's fingerprint.
    const keepCredentials = options.keepCredentials ?? session.sealOnStop ?? true;
    // Capture a token the runtime refreshed during this session before the
    // plaintext copy is removed.
    if (keepCredentials) { try { seal(session.ownerKey, session.connectionId, {}, { refreshOnly: true }); } catch { /* sealing is best effort on shutdown */ } }
    // Closing only sends SIGTERM; the child may run for a few more seconds. The
    // lease is the promise that nothing is using this identity, so it is marked
    // as terminating now and released only once the child has actually exited.
    // Releasing it earlier would let a replacement start beside a live process.
    session.client.close(reason);
    live.delete(runtimeKey(session.ownerKey, session.connectionId));
    releaseAfterExit(session.ownerKey, session.connectionId, session.leaseId, session.client);
    trackTermination(session);
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

// Stops every runtime and waits for the children to exit, so the deferred
// release and the plaintext removal actually run. Without this wait a shutdown
// leaves a hydrated credential on disk while the service is offline.
export async function shutdownRuntimes({ timeoutMs = SHUTDOWN_WAIT_MS } = {}) {
    // Sessions already on their way out count as well: their child is still alive
    // and their credential file is still on disk.
    const pending = [...live.values(), ...terminating].map(session => session.client.exited);
    stopAllRuntimes('AI_CODEX_RUNTIME_CLOSED');
    if (!pending.length) return;
    await Promise.race([
        Promise.allSettled(pending),
        new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })
    ]);
    // The release runs in a continuation of `exited`; let it settle.
    await new Promise(resolve => { const timer = setImmediate(resolve); timer.unref?.(); });
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
    process.on('exit', () => {
        // Nothing asynchronous can run any more, so the plaintext of whatever is
        // still live is removed synchronously here.
        const remaining = [...live.values(), ...terminating];
        stopAllRuntimes('AI_CODEX_RUNTIME_CLOSED');
        for (const session of remaining) {
            // Only while this session still owns the lease: another worker may
            // already have started a replacement for the same identity.
            try {
                db.transaction(() => {
                    const stillOurs = db.prepare('SELECT 1 FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=?')
                        .get(session.ownerKey, session.connectionId, session.leaseId);
                    if (stillOurs) clearPlaintext(session.ownerKey, session.connectionId);
                }).immediate();
            } catch { /* best effort on exit */ }
        }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        const handler = async () => {
            // Re-raising at once would kill the process before the children exit
            // and their credential files are removed.
            try { await shutdownRuntimes(); } catch { /* shutdown proceeds regardless */ }
            process.removeListener(signal, handler);
            process.kill(process.pid, signal);
        };
        process.on(signal, handler);
    }
}
