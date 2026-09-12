import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import db from '../../../database/db.js';
import { ENCRYPTION_KEY } from '../../../utils/crypto.js';
import { aiError } from '../transport.js';
import { codexReadinessSnapshot, refreshCodexReadiness } from './readiness.js';
import { startRuntime, stopRuntime, liveRuntime, withRuntime } from './runtime.js';
import { startDeviceLogin, cancelLogin, logout, readAccount, getAuthStatus, readRateLimits } from './client.js';
import { seal, wipe, accountFingerprint, maskAccount, linkedElsewhere, readCredentialRecord } from './credentials.js';

const LOGIN_TTL_MS = 15 * 60 * 1000;
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

function actorRow(actor) {
    const table = actor.is_admin ? 'admin_users' : 'users';
    const row = db.prepare(`SELECT id,is_active,token_version${actor.is_admin ? '' : ',webui_access'} FROM ${table} WHERE id=?`).get(actor.id);
    if (!row || !row.is_active || (!actor.is_admin && !row.webui_access)) throw aiError('AI_FORBIDDEN', 403);
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

function releaseAttempt(id) {
    const attempt = attempts.get(id);
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempts.delete(id);
    stopRuntime(attempt.session, 'AI_CODEX_RUNTIME_CLOSED');
}

// A late success must never be adopted after the account signed out, changed
// identity, cancelled the attempt or started a different one.
function stillOwnsAttempt(row, ownerKey) {
    const current = db.prepare('SELECT status,actor_version,session_hash FROM ai_codex_logins WHERE id=?').get(row.id);
    if (!current || !ACTIVE_STATUSES.includes(current.status)) return false;
    const [kind, id] = ownerKey.split(':');
    const table = kind === 'admin' ? 'admin_users' : 'users';
    const account = db.prepare(`SELECT is_active,token_version FROM ${table} WHERE id=?`).get(Number(id));
    if (!account?.is_active || account.token_version !== current.actor_version) return false;
    return current.session_hash === row.session_hash;
}

async function completeLogin(row, ownerKey, connectionId, notification) {
    const attempt = attempts.get(row.id);
    if (!attempt) return;
    const session = attempt.session;
    try {
        if (notification?.loginId && row.login_id && notification.loginId !== row.login_id) return;
        if (!notification?.success) {
            finishLogin(row.id, 'failed', 'ai_codex_login_rejected');
            return;
        }
        if (!stillOwnsAttempt(row, ownerKey)) {
            // The attempt no longer belongs to the current session: sign the
            // runtime out again and keep nothing locally.
            await logout(session).catch(() => null);
            wipe(ownerKey, connectionId);
            finishLogin(row.id, 'failed', 'ai_codex_login_superseded');
            return;
        }
        const status = await getAuthStatus(session);
        if (status.authMethod !== 'chatgpt') {
            await logout(session).catch(() => null);
            wipe(ownerKey, connectionId);
            finishLogin(row.id, 'failed', 'ai_codex_unexpected_auth');
            return;
        }
        const account = await readAccount(session);
        const fingerprint = accountFingerprint(account.email);
        if (linkedElsewhere(ownerKey, connectionId, fingerprint)) {
            await logout(session).catch(() => null);
            wipe(ownerKey, connectionId);
            finishLogin(row.id, 'failed', 'ai_codex_account_already_linked');
            return;
        }
        const sealed = seal(ownerKey, connectionId, {
            accountHash: fingerprint,
            accountLabel: maskAccount(account.email),
            planType: typeof account.planType === 'string' ? account.planType.slice(0, 40) : null,
            authMethod: status.authMethod
        });
        if (!sealed.sealed) {
            await logout(session).catch(() => null);
            wipe(ownerKey, connectionId);
            finishLogin(row.id, 'failed', 'ai_codex_credentials_unavailable');
            return;
        }
        finishLogin(row.id, 'completed');
    } catch {
        finishLogin(row.id, 'failed', 'ai_codex_login_failed');
    } finally {
        releaseAttempt(row.id);
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
    const recent = db.prepare("SELECT count(*) AS n FROM ai_codex_logins WHERE owner_key=? AND created_at>?").get(ownerKey, Date.now() - 3600000).n;
    if (recent >= MAX_LOGINS_PER_HOUR) throw aiError('AI_RATE_LIMIT', 429);
    // Repeated clicks supersede the previous attempt rather than opening a new
    // parallel sign-in for the same identity.
    for (const row of db.prepare("SELECT id FROM ai_codex_logins WHERE owner_key=? AND status IN ('starting','pending')").all(ownerKey)) {
        finishLogin(row.id, 'cancelled', 'ai_codex_login_superseded');
        releaseAttempt(row.id);
    }
    if (liveRuntime(ownerKey, connection.id)) throw aiError('AI_BUSY', 409);

    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO ai_codex_logins(id,owner_key,connection_id,login_id,status,verification_url,user_code,actor_version,session_hash,created_at,updated_at,expires_at)
        VALUES(?,?,?,NULL,'starting',NULL,NULL,?,?,?,?,?)`)
        .run(id, ownerKey, connection.id, account.token_version, fingerprint, now, now, now + LOGIN_TTL_MS);
    const row = db.prepare('SELECT * FROM ai_codex_logins WHERE id=?').get(id);

    let session;
    try {
        session = await startRuntime(ownerKey, connection.id, {
            onNotification: (method, params) => {
                if (method === 'account/login/completed') completeLogin(row, ownerKey, connection.id, params).catch(() => null);
            }
        });
        const timer = setTimeout(() => { finishLogin(id, 'expired', 'ai_codex_login_expired'); releaseAttempt(id); }, LOGIN_TTL_MS);
        timer.unref?.();
        attempts.set(id, { session, timer });
        const device = await startDeviceLogin(session);
        db.prepare("UPDATE ai_codex_logins SET login_id=?,status='pending',verification_url=?,user_code=?,updated_at=? WHERE id=? AND status='starting'")
            .run(device.loginId, device.verificationUrl, device.userCode, Date.now(), id);
        row.login_id = device.loginId;
        return { id, status: 'pending', verification_url: device.verificationUrl, user_code: device.userCode, expires_at: now + LOGIN_TTL_MS };
    } catch (error) {
        finishLogin(id, 'failed', /^AI_CODEX_[A-Z_]+$/.test(error?.code || '') ? error.code.toLowerCase() : 'ai_codex_login_failed');
        releaseAttempt(id);
        if (session && !attempts.has(id)) stopRuntime(session, 'AI_CODEX_RUNTIME_CLOSED');
        throw error;
    }
}

export function readLoginStatus(actor, connection, id) {
    actorRow(actor);
    expireLogins();
    const row = loginRow(connection.owner_key, connection.id, id);
    // A pending attempt whose runtime is gone cannot complete in this process.
    if (ACTIVE_STATUSES.includes(row.status) && !attempts.has(row.id)) {
        finishLogin(row.id, 'failed', 'ai_codex_login_interrupted');
        return { ...publicLogin(row), status: 'failed', error_code: 'ai_codex_login_interrupted' };
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
    const attempt = attempts.get(row.id);
    if (attempt && row.login_id) await cancelLogin(attempt.session, row.login_id).catch(() => null);
    finishLogin(row.id, 'cancelled', 'ai_codex_login_cancelled');
    releaseAttempt(row.id);
    return { id: row.id, status: 'cancelled' };
}

// Disconnecting blocks new work, ends queued and running work, signs the runtime
// out and removes the local credential. A failed remote sign-out never keeps
// local access alive; the difference is reported instead.
export async function disconnectAccount(actor, connection) {
    actorRow(actor);
    const ownerKey = connection.owner_key;
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
    let remote = false;
    if (readCredentialRecord(ownerKey, connection.id)) {
        try { remote = await withRuntime(ownerKey, connection.id, session => logout(session)); }
        catch { remote = false; }
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
    return withRuntime(connection.owner_key, connection.id, async session => {
        const status = await getAuthStatus(session);
        if (status.authMethod !== 'chatgpt') {
            return { linked: false, label: null, plan_type: null, auth_method: status.authMethod, quota: { known: false } };
        }
        const account = await readAccount(session, { refreshToken: true });
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
}

export function releaseAllAttempts() {
    for (const id of [...attempts.keys()]) { finishLogin(id, 'failed', 'ai_codex_login_interrupted'); releaseAttempt(id); }
}
