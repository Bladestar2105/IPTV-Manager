import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import db from '../../../database/db.js';
import { ENCRYPTION_KEY } from '../../../utils/crypto.js';
import { aiError } from '../transport.js';
import { requireAiFeatureAccess, adjustConnectionTeardown } from '../connections.js';
import { codexReadinessSnapshot, refreshCodexReadiness } from './readiness.js';
import { startRuntime, stopRuntime, liveRuntime, withRuntime, runtimeState } from './runtime.js';
import { startDeviceLogin, cancelLogin, logout, readAccount, getAuthStatus, readRateLimits } from './client.js';
import { seal, wipe, clearPlaintext, purgeIdentity, accountFingerprint, maskAccount, linkedElsewhere, readCredentialRecord } from './credentials.js';

const LOGIN_TTL_MS = 15 * 60 * 1000;
// A sign-in belongs to the browser session that started it. That session polls
// its own attempt every few seconds while the panel is open; once it stops for
// longer than this, the attempt is no longer watched and a completion arriving
// afterwards is not adopted.
const LOGIN_SESSION_IDLE_MS = 120000;
// How long a replacement sign-in waits for the previous one's runtime lease to
// be released. A supersede handled by another worker is applied by that worker's
// watchdog, which polls the shared row once a second.
const LEASE_HANDOVER_TIMEOUT_MS = 6000;
const ATTEMPT_WATCH_MS = 1000;
const MAX_LOGINS_PER_HOUR = 5;
const ACTIVE_STATUSES = ['starting', 'pending'];

// Login runtimes owned by this worker. A pending device-code login only exists
// inside the process that started it; a worker loss ends that attempt instead of
// letting another worker adopt a foreign sign-in session.
const attempts = new Map();

export const sessionFingerprint = token =>
    (typeof token === 'string' && token
        ? crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex')).update(token).digest('hex')
        : null);

// One predicate for every access field an owner must still satisfy, matching the
// checks the rest of the AI subsystem applies: active account, Web UI access and
// an unexpired account.
// The same server-enablement and allowed-user gate the setup endpoints apply.
// Polling deliberately bypasses it so a revoked owner can still cancel, which
// means the asynchronous completion has to check it itself.
function policyAllows(ownerKey) {
    const [kind, id] = ownerKey.split(':');
    try {
        requireAiFeatureAccess({ id: Number(id), is_admin: kind === 'admin' }, 'setup');
        return true;
    } catch { return false; }
}

function usableAccount(ownerKey) {
    const [kind, id] = ownerKey.split(':');
    const admin = kind === 'admin';
    const table = admin ? 'admin_users' : 'users';
    const row = db.prepare(`SELECT id,is_active,token_version${admin ? '' : ',webui_access,expiry_date'} FROM ${table} WHERE id=?`).get(Number(id));
    if (!row || !row.is_active) return null;
    if (!admin && (!row.webui_access || (row.expiry_date && row.expiry_date < Date.now() / 1000))) return null;
    return row;
}

function actorRow(actor) {
    const row = usableAccount(`${actor.is_admin ? 'admin' : 'user'}:${actor.id}`);
    if (!row) throw aiError('AI_FORBIDDEN', 403);
    return row;
}

function expireLogins() {
    const now = Date.now();
    db.prepare(`UPDATE ai_codex_logins SET status='expired', error_code=COALESCE(error_code,'ai_codex_login_expired'), updated_at=?
        WHERE status IN ('starting','pending') AND expires_at < ?`).run(now, now);
    db.prepare("DELETE FROM ai_codex_logins WHERE status NOT IN ('starting','pending') AND updated_at < ?").run(now - 86400000);
}

function loginRow(ownerKey, connectionId, id) {
    const row = db.prepare('SELECT * FROM ai_codex_logins WHERE id=? AND owner_key=? AND connection_id=?').get(id, ownerKey, connectionId);
    if (!row) throw aiError('AI_NOT_FOUND', 404);
    return row;
}

function finishLogin(id, status, errorCode = null) {
    db.prepare("UPDATE ai_codex_logins SET status=?, error_code=?, updated_at=? WHERE id=? AND status IN ('starting','pending')")
        .run(status, errorCode, Date.now(), id);
}

// Used only after an attempt was already claimed, where the conditional finish
// above can no longer match.
function forceLoginFailure(id, errorCode) {
    db.prepare('UPDATE ai_codex_logins SET status=?, error_code=?, updated_at=? WHERE id=?')
        .run('failed', errorCode, Date.now(), id);
}

function releaseAttempt(id) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    clearInterval(attempt.watchdog);
    attempts.delete(id);
    // A sign-in attempt never seals on teardown. A successful one already sealed
    // explicitly; for a cancelled or superseded one the file Codex just wrote
    // belongs to an account that was never adopted, and a refresh-only seal would
    // let it replace an existing credential while keeping the old fingerprint.
    stopRuntime(attempt.session, 'AI_CODEX_RUNTIME_CLOSED', { keepCredentials: false });
}

// A cancel or a supersede can be handled by any worker, so the worker that owns
// the runtime watches the shared row and releases it when the attempt is no
// longer active.
function watchAttempt(id) {
    const watchdog = setInterval(() => {
        const row = db.prepare('SELECT status FROM ai_codex_logins WHERE id=?').get(id);
        if (!row || !ACTIVE_STATUSES.includes(row.status)) releaseAttempt(id);
    }, ATTEMPT_WATCH_MS);
    watchdog.unref?.();
    return watchdog;
}

// A late success must never be adopted after the attempt was cancelled or
// superseded, after the account was disabled or its tokens were invalidated, or
// after the session that started it stopped watching. Sign-out in this
// application is client side and does not advance `token_version`, so session
// ownership is established by the initiating session's own polling rather than
// by a stored value compared against itself.
function stillOwnsAttempt(row, ownerKey) {
    const current = db.prepare('SELECT status,actor_version,session_hash,created_at,last_seen_at FROM ai_codex_logins WHERE id=?').get(row.id);
    if (!current || !ACTIVE_STATUSES.includes(current.status)) return false;
    if (current.session_hash !== row.session_hash) return false;
    // Web UI access can be revoked and an account can expire while the code is
    // open; adopting the sign-in then would grant what was just taken away.
    const account = usableAccount(ownerKey);
    if (!account || account.token_version !== current.actor_version) return false;
    // AI access can be withdrawn centrally or personally while the code is open.
    if (!policyAllows(ownerKey)) return false;
    return Date.now() - (current.last_seen_at ?? current.created_at) <= LOGIN_SESSION_IDLE_MS;
}

// Claims the attempt in one step, so a cancellation, an unlink or a supersede
// that lands while the account is being read cannot be overtaken by the seal
// that follows. Ownership is re-evaluated inside the transaction; only a claim
// that actually changed the row authorizes storing a credential.
function claimCompletedLogin(row, ownerKey) {
    return db.transaction(() => {
        if (!stillOwnsAttempt(row, ownerKey)) return false;
        return db.prepare("UPDATE ai_codex_logins SET status='completed', error_code=NULL, updated_at=? WHERE id=? AND status IN ('starting','pending')")
            .run(Date.now(), row.id).changes > 0;
    }).immediate();
}

// Discards everything this attempt produced. A connection that was already
// linked keeps its credential: a rejected replacement must not disconnect the
// account that was working before it started.
async function discardAttempt(session, ownerKey, connectionId, hadCredential) {
    if (hadCredential) { clearPlaintext(ownerKey, connectionId); return; }
    await logout(session).catch(() => null);
    wipe(ownerKey, connectionId);
}

async function completeLogin(row, ownerKey, connectionId, notification) {
    const attempt = attempts.get(row.id);
    if (!attempt) return;
    // Read before anything this attempt could store; an attempt never seals on
    // teardown, so only its own success can add a record.
    const hadCredential = Boolean(readCredentialRecord(ownerKey, connectionId));
    // Not our completion: leave the attempt and its runtime alone so the real
    // one can still arrive. Returning inside the try below would run its
    // `finally` and stop the pending runtime.
    if (notification?.loginId && row.login_id && notification.loginId !== row.login_id) return;
    const session = attempt.session;
    try {
        if (!notification?.success) {
            finishLogin(row.id, 'failed', 'ai_codex_login_rejected');
            return;
        }
        if (!stillOwnsAttempt(row, ownerKey)) {
            // The attempt no longer belongs to the current session: sign the
            // runtime out again and keep nothing locally.
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            finishLogin(row.id, 'failed', 'ai_codex_login_superseded');
            return;
        }
        const status = await getAuthStatus(session);
        if (status.authMethod !== 'chatgpt') {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            finishLogin(row.id, 'failed', 'ai_codex_unexpected_auth');
            return;
        }
        const account = await readAccount(session);
        // A completion the runtime cannot back with an account is not a sign-in.
        // Claiming it would report the connection as linked while the runtime
        // says otherwise.
        if (!account.linked) {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            finishLogin(row.id, 'failed', 'ai_codex_account_unavailable');
            return;
        }
        const fingerprint = accountFingerprint(account.email);
        // The one-account rule rests on a reported identity. Without one it could
        // not be enforced, and a null fingerprint would slip past the constraint.
        if (!fingerprint) {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            finishLogin(row.id, 'failed', 'ai_codex_account_unidentified');
            return;
        }
        if (linkedElsewhere(ownerKey, connectionId, fingerprint)) {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            finishLogin(row.id, 'failed', 'ai_codex_account_already_linked');
            return;
        }
        // The runtime lease serializes sign-ins for one identity and connection,
        // so a failed claim means this attempt was ended and nothing newer has
        // linked yet: signing out and removing the local credential is safe.
        if (!claimCompletedLogin(row, ownerKey)) {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            return;
        }
        let sealed;
        try { sealed = seal(ownerKey, connectionId, {
            accountHash: fingerprint,
            accountLabel: maskAccount(account.email),
            planType: typeof account.planType === 'string' ? account.planType.slice(0, 40) : null,
            authMethod: status.authMethod
        }); } catch { sealed = { sealed: false }; }
        if (!sealed.sealed) {
            await discardAttempt(session, ownerKey, connectionId, hadCredential);
            forceLoginFailure(row.id, 'ai_codex_credentials_unavailable');
        }
    } catch {
        finishLogin(row.id, 'failed', 'ai_codex_login_failed');
    } finally {
        releaseAttempt(row.id);
    }
}

// A supersede or cancel handled by another worker is applied by that worker's
// watchdog, so the replacement waits briefly for the shared lease to disappear
// instead of colliding with it.
async function waitForLeaseRelease(ownerKey, connectionId) {
    const deadline = Date.now() + LEASE_HANDOVER_TIMEOUT_MS;
    for (;;) {
        if (!liveRuntime(ownerKey, connectionId) && !runtimeState(ownerKey, connectionId)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => { const timer = setTimeout(resolve, 200); timer.unref?.(); });
    }
}

export function codexStatus() {
    const readiness = codexReadinessSnapshot();
    if (!readiness.available) refreshCodexReadiness().catch(() => null);
    return {
        available: readiness.available === true,
        reason: readiness.available ? null : readiness.reason,
        codex_version: readiness.version ?? null,
        isolation: readiness.available ? { backend: readiness.backend, grade: readiness.grade } : null
    };
}

export async function startAccountLink(actor, connection, fingerprint) {
    const ownerKey = connection.owner_key;
    const readiness = codexReadinessSnapshot();
    if (!readiness.available) throw aiError(readiness.reason, 503);
    if (!fingerprint) throw aiError('AI_FORBIDDEN', 403);
    const account = actorRow(actor);
    expireLogins();
    // Only an attempt that actually produced a device code counts against the
    // budget. A start that never got that far consumed nothing the account
    // holder could use.
    const recent = db.prepare("SELECT count(*) AS n FROM ai_codex_logins WHERE owner_key=? AND created_at>? AND login_id IS NOT NULL")
        .get(ownerKey, Date.now() - 3600000).n;
    if (recent >= MAX_LOGINS_PER_HOUR) throw aiError('AI_RATE_LIMIT', 429);
    // Repeated clicks supersede the previous attempt rather than opening a new
    // parallel sign-in for the same identity. When the previous attempt lives in
    // another worker this only marks the shared row; that worker's watchdog then
    // stops its runtime and releases the lease.
    for (const row of db.prepare("SELECT id FROM ai_codex_logins WHERE owner_key=? AND status IN ('starting','pending')").all(ownerKey)) {
        finishLogin(row.id, 'cancelled', 'ai_codex_login_superseded');
        releaseAttempt(row.id);
    }
    // Wait for the handover before claiming the lease, and refuse without
    // recording an attempt if the previous runtime does not let go, so a
    // collision never consumes part of the budget.
    if (!(await waitForLeaseRelease(ownerKey, connection.id))) throw aiError('AI_BUSY', 409);

    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at)
        VALUES(?,?,?,NULL,'starting',NULL,NULL,?,?,?,?,?)`)
        .run(id, ownerKey, connection.id, account.token_version, fingerprint, now, now, now + LOGIN_TTL_MS);
    db.prepare('UPDATE ai_codex_logins SET last_seen_at=? WHERE id=?').run(now, id);
    const row = db.prepare('SELECT * FROM ai_codex_logins WHERE id=?').get(id);

    let session;
    try {
        session = await startRuntime(ownerKey, connection.id, {
            // Every close path of a sign-in runtime discards its credential file,
            // including a crash before any completion notification.
            sealOnStop: false,
            onNotification: (method, params) => {
                if (method === 'account/login/completed') completeLogin(row, ownerKey, connection.id, params).catch(() => null);
            },
            // The runtime can die after issuing the device code and before any
            // completion. Nothing can finish the sign-in then, so it is reported
            // at once instead of waiting out the fifteen-minute expiry.
            onClosed: () => { finishLogin(id, 'failed', 'ai_codex_login_interrupted'); releaseAttempt(id); }
        });
        const timer = setTimeout(() => { finishLogin(id, 'expired', 'ai_codex_login_expired'); releaseAttempt(id); }, LOGIN_TTL_MS);
        timer.unref?.();
        attempts.set(id, { session, timer, watchdog: watchAttempt(id) });
        const device = await startDeviceLogin(session);
        const opened = db.prepare("UPDATE ai_codex_logins SET login_id=?,status='pending',verification_url=?,user_code=?,updated_at=? WHERE id=? AND status='starting'")
            .run(device.loginId, device.verificationUrl, device.userCode, Date.now(), id);
        // The attempt may already have been ended while the device code was being
        // fetched; reporting it as pending would be untrue.
        if (!opened.changes) throw aiError('AI_CODEX_RUNTIME_CLOSED', 503);
        row.login_id = device.loginId;
        return { id, status: 'pending', verification_url: device.verificationUrl, user_code: device.userCode, expires_at: now + LOGIN_TTL_MS };
    } catch (error) {
        finishLogin(id, 'failed', /^AI_CODEX_[A-Z_]+$/.test(error?.code || '') ? error.code.toLowerCase() : 'ai_codex_login_failed');
        releaseAttempt(id);
        if (session && !attempts.has(id)) stopRuntime(session, 'AI_CODEX_RUNTIME_CLOSED');
        throw error;
    }
}

// Polling is not routed to any particular worker, so the process-local attempt
// map cannot decide whether a sign-in is still running. The runtime lease in the
// database is the shared truth; only when no worker holds it is the attempt
// really gone. Each poll from the initiating session also refreshes the
// attempt's liveness.
export function readLoginStatus(actor, connection, id, fingerprint = null) {
    actorRow(actor);
    expireLogins();
    const row = loginRow(connection.owner_key, connection.id, id);
    if (fingerprint && row.session_hash !== fingerprint) throw aiError('AI_NOT_FOUND', 404);
    if (ACTIVE_STATUSES.includes(row.status)) {
        // A local attempt whose runtime already closed can never complete, even
        // while its lease is still being refreshed elsewhere.
        const localAttempt = attempts.get(row.id);
        if (localAttempt?.session?.client?.closed) {
            finishLogin(row.id, 'failed', 'ai_codex_login_interrupted');
            releaseAttempt(row.id);
            return { ...publicLogin(row), status: 'failed', error_code: 'ai_codex_login_interrupted' };
        }
        if (!localAttempt && !runtimeState(connection.owner_key, connection.id)) {
            finishLogin(row.id, 'failed', 'ai_codex_login_interrupted');
            return { ...publicLogin(row), status: 'failed', error_code: 'ai_codex_login_interrupted' };
        }
        if (fingerprint) db.prepare('UPDATE ai_codex_logins SET last_seen_at=? WHERE id=? AND session_hash=?').run(Date.now(), row.id, fingerprint);
    }
    return publicLogin(row);
}

function publicLogin(row) {
    return {
        id: row.id,
        status: row.status,
        // Never a token: only the documented verification address and the code
        // the account holder types on it.
        verification_url: row.verification_url,
        user_code: row.user_code,
        error_code: row.error_code,
        expires_at: row.expires_at
    };
}

export async function cancelAccountLink(actor, connection, id) {
    actorRow(actor);
    const row = loginRow(connection.owner_key, connection.id, id);
    // The row is ended first: a completion racing in while the cancel call is in
    // flight then fails to claim the attempt instead of linking the account.
    const claimed = db.prepare("UPDATE ai_codex_logins SET status='cancelled', error_code='ai_codex_login_cancelled', updated_at=? WHERE id=? AND status IN ('starting','pending')")
        .run(Date.now(), row.id).changes > 0;
    if (claimed) {
        const attempt = attempts.get(row.id);
        if (attempt && row.login_id) await cancelLogin(attempt.session, row.login_id).catch(() => null);
        releaseAttempt(row.id);
    }
    // A completion that claimed the attempt first has already won. Reporting
    // "cancelled" then would tell the account holder the opposite of what
    // happened.
    const current = db.prepare('SELECT status,error_code FROM ai_codex_logins WHERE id=?').get(row.id);
    return { id: row.id, status: current?.status ?? 'cancelled', error_code: current?.error_code ?? null };
}

// Disconnecting blocks new work, ends queued and running work, signs the runtime
// out and removes the local credential. A failed remote sign-out never keeps
// local access alive; the difference is reported instead.
export async function disconnectAccount(actor, connection) {
    actorRow(actor);
    const ownerKey = connection.owner_key;
    // Marked for the whole operation, so work started after the scan below cannot
    // take the lease and keep using a credential this is about to remove. The
    // count keeps the marker in place while an overlapping teardown, such as a
    // deletion, is still running.
    adjustConnectionTeardown(ownerKey, connection.id, 1);
    try {
        return await runDisconnect(actor, connection, ownerKey);
    } finally {
        try { adjustConnectionTeardown(ownerKey, connection.id, -1); } catch { /* the row may be gone already */ }
    }
}

async function runDisconnect(actor, connection, ownerKey) {
    for (const row of db.prepare("SELECT id FROM ai_codex_logins WHERE owner_key=? AND connection_id=? AND status IN ('starting','pending')").all(ownerKey, connection.id)) {
        finishLogin(row.id, 'cancelled', 'ai_codex_login_cancelled');
        releaseAttempt(row.id);
    }
    const { cancelJob } = await import('../jobs.js');
    for (const job of db.prepare("SELECT id FROM ai_jobs WHERE owner_key=? AND connection_id=? AND status IN ('queued','running')").all(ownerKey, connection.id)) {
        try { cancelJob(actor, job.id); } catch { /* already finished */ }
    }
    const live = liveRuntime(ownerKey, connection.id);
    if (live) stopRuntime(live, 'AI_CODEX_RUNTIME_CLOSED');
    // A runtime owned by another worker cannot be stopped from here. Marking its
    // lease revoked is the shared signal; that worker's guard sees it within a
    // second and releases the row, and only that release is an acknowledgement
    // that its runtime has actually stopped. Deleting the row here instead would
    // make the wait trivially true and allow a second runtime on the same
    // identity directory while the first is still running.
    let acknowledged = true;
    if (runtimeState(ownerKey, connection.id)) {
        db.prepare("UPDATE ai_codex_runtimes SET state='revoked', updated_at=? WHERE owner_key=? AND connection_id=?")
            .run(Date.now(), ownerKey, connection.id);
        acknowledged = await waitForLeaseRelease(ownerKey, connection.id);
        // No acknowledgement means the owner is gone, not that it is safe to run
        // alongside it: local access is still removed and the difference reported.
        if (!acknowledged) db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').run(ownerKey, connection.id);
    }
    let remote = false;
    if (acknowledged && readCredentialRecord(ownerKey, connection.id)) {
        try { remote = await withRuntime(ownerKey, connection.id, session => logout(session)); }
        catch { remote = false; }
        // The sign-out runtime has only been signalled; wiping now would free the
        // identity for a relink whose files that child's pending cleanup could
        // then remove.
        await waitForLeaseRelease(ownerKey, connection.id);
    }
    wipe(ownerKey, connection.id);
    return { disconnected: true, remote_logout: remote };
}

// Account and quota facts come only from the documented interface. Anything it
// does not report stays unknown rather than being estimated locally.
export async function readAccountState(actor, connection) {
    actorRow(actor);
    const record = readCredentialRecord(connection.owner_key, connection.id);
    if (!record) return { linked: false, label: null, plan_type: null, auth_method: null, quota: { known: false } };
    const readiness = codexReadinessSnapshot();
    if (!readiness.available) {
        return { linked: true, label: record.account_label, plan_type: record.plan_type, auth_method: record.auth_method,
            quota: { known: false }, unavailable_reason: readiness.reason };
    }
    if (liveRuntime(connection.owner_key, connection.id)) throw aiError('AI_BUSY', 409);
    // A stored credential that no longer authenticates an account is not a link.
    // Keeping the record would make the connection read as linked again on the
    // next load and send later jobs at an invalid credential.
    let invalidate = false;
    const state = await withRuntime(connection.owner_key, connection.id, async session => {
        const status = await getAuthStatus(session);
        if (status.authMethod !== 'chatgpt') {
            invalidate = true;
            return { linked: false, label: null, plan_type: null, auth_method: status.authMethod, quota: { known: false } };
        }
        const account = await readAccount(session, { refreshToken: true });
        if (!account.linked) {
            invalidate = true;
            return { linked: false, label: null, plan_type: null, auth_method: null, quota: { known: false } };
        }
        const quota = await readRateLimits(session);
        // A refresh performed during this read is captured immediately.
        seal(connection.owner_key, connection.id, {
            accountLabel: maskAccount(account.email) ?? record.account_label,
            planType: account.planType ?? record.plan_type,
            authMethod: status.authMethod
        }, { refreshOnly: true });
        return {
            linked: account.linked,
            label: maskAccount(account.email) ?? record.account_label,
            plan_type: account.planType ?? record.plan_type,
            auth_method: status.authMethod,
            quota
        };
    });
    // Removed only once the child has handed the identity back; wiping while it
    // still runs would free the identity for a relink beside a live process.
    if (invalidate) {
        await waitForLeaseRelease(connection.owner_key, connection.id);
        wipe(connection.owner_key, connection.id);
    }
    return state;
}

// Ends every runtime of an account before its runtime state is removed, so a
// deletion never returns while a child is still using that account's credential.
export async function purgeAccountRuntimes(ownerKey) {
    for (const row of db.prepare("SELECT id FROM ai_codex_logins WHERE owner_key=? AND status IN ('starting','pending')").all(ownerKey)) {
        finishLogin(row.id, 'cancelled', 'ai_codex_login_cancelled');
        releaseAttempt(row.id);
    }
    for (const row of db.prepare('SELECT connection_id FROM ai_codex_runtimes WHERE owner_key=?').all(ownerKey)) {
        const live = liveRuntime(ownerKey, row.connection_id);
        if (live) stopRuntime(live, 'AI_CODEX_RUNTIME_CLOSED');
        db.prepare("UPDATE ai_codex_runtimes SET state='revoked', updated_at=? WHERE owner_key=? AND connection_id=?")
            .run(Date.now(), ownerKey, row.connection_id);
        if (!(await waitForLeaseRelease(ownerKey, row.connection_id))) {
            db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').run(ownerKey, row.connection_id);
        }
    }
    purgeIdentity(ownerKey);
}

export function releaseAllAttempts() {
    for (const id of [...attempts.keys()]) { finishLogin(id, 'failed', 'ai_codex_login_interrupted'); releaseAttempt(id); }
}
