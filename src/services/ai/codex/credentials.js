import crypto, { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import db from '../../../database/db.js';
import { accountRow } from './identity.js';
import { encrypt, decrypt, ENCRYPTION_KEY } from '../../../utils/crypto.js';
import { codexConfig } from './config.js';

const AUTH_FILE = 'auth.json';
// How long a lease whose process could not be ended is held before anything may
// look at it again. It is never swept on the timestamp alone; this only keeps it
// from looking expired in the meantime.
const ORPHAN_HOLD_MS = 300000;
const MAX_AUTH_BYTES = 256 * 1024;

// Codex owns its credential file. It is only ever materialized inside the
// identity's own 0700 runtime directory while a runtime is live, and is sealed
// with the application encryption key between runs. This is protection against
// other accounts and against a plain database or backup copy, not against the
// server operator, who can read the application key by design.
//
// Directories are nested by account and then by connection, so deleting an
// account removes exactly its own tree instead of relying on a global sweep that
// would also delete a directory another account is signing in with. The prefixes
// keep the two digests in separate namespaces; the owner key itself cannot
// contain a slash, so no pair can collide.
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const ownerDirectory = ownerKey => digest(`owner/${ownerKey}`);
const connectionDirectory = (ownerKey, connectionId) => digest(`connection/${ownerKey}/${connectionId}`);
const identitiesRoot = () => path.join(codexConfig().runtimeDir, 'identities');

export function identityPaths(ownerKey, connectionId) {
    const ownerRoot = path.join(identitiesRoot(), ownerDirectory(ownerKey));
    const root = path.join(ownerRoot, connectionDirectory(ownerKey, connectionId));
    return { ownerRoot, root, codexHome: path.join(root, 'home'), workDir: path.join(root, 'work'), authFile: path.join(root, 'home', AUTH_FILE) };
}

// Stable pseudonym for a reported external account. The address itself is never
// stored, logged or compared in clear text.
export function accountFingerprint(email) {
    if (typeof email !== 'string' || !email.trim()) return null;
    return crypto.createHmac('sha256', Buffer.from(ENCRYPTION_KEY, 'hex')).update(email.trim().toLowerCase()).digest('hex');
}

export function maskAccount(email) {
    if (typeof email !== 'string' || !email.includes('@')) return null;
    const [name, domain] = [email.slice(0, email.lastIndexOf('@')), email.slice(email.lastIndexOf('@') + 1)];
    const visible = name.slice(0, 1);
    return `${visible}${'*'.repeat(Math.max(name.length - 1, 1))}@${domain}`.slice(0, 120);
}

export function readCredentialRecord(ownerKey, connectionId) {
    return db.prepare('SELECT * FROM ai_codex_credentials WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId) || null;
}

export function linkedElsewhere(ownerKey, connectionId, accountHash) {
    if (!accountHash) return false;
    const row = db.prepare('SELECT owner_key,connection_id FROM ai_codex_credentials WHERE account_hash=?').get(accountHash);
    return Boolean(row) && !(row.owner_key === ownerKey && row.connection_id === connectionId);
}

function writeAtomic(target, contents) {
    const temporary = `${target}.tmp`;
    // The runtime can write in this directory, so never follow a link it may have
    // put in place of the file being written.
    fs.rmSync(temporary, { force: true });
    const handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
        fs.writeFileSync(handle, contents);
        fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, target);
    // Durable rename where the platform allows a directory descriptor.
    let directory = null;
    try { directory = fs.openSync(path.dirname(target), 'r'); fs.fsyncSync(directory); }
    catch { /* directory fsync is best effort and unsupported on some platforms */ }
    finally { if (directory !== null) { try { fs.closeSync(directory); } catch { /* already closed */ } } }
}

export function prepareIdentityDirectory(ownerKey, connectionId) {
    const paths = identityPaths(ownerKey, connectionId);
    for (const dir of [paths.ownerRoot, paths.root, paths.codexHome, paths.workDir, path.join(paths.workDir, 'tmp')]) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o700);
    }
    fs.rmSync(`${paths.authFile}.tmp`, { force: true });
    return paths;
}

// Restores a previously sealed credential file before a runtime starts. A
// missing or undecryptable record means "signed out", never a fallback to
// another identity or credential source.
export function hydrate(ownerKey, connectionId) {
    const paths = prepareIdentityDirectory(ownerKey, connectionId);
    const record = readCredentialRecord(ownerKey, connectionId);
    if (!record) { fs.rmSync(paths.authFile, { force: true }); return { ...paths, restored: false, record: null }; }
    let plaintext = null;
    try { plaintext = decrypt(record.encrypted_blob); } catch { plaintext = null; }
    if (!plaintext || plaintext.length > MAX_AUTH_BYTES) {
        fs.rmSync(paths.authFile, { force: true });
        return { ...paths, restored: false, record, corrupt: true };
    }
    writeAtomic(paths.authFile, plaintext);
    return { ...paths, restored: true, record };
}

// Captures a refreshed credential file. Called after login completion and after
// every operation that can rotate the token, so a crash between runs cannot
// leave the sealed copy behind the live one.
// `refreshOnly` captures a rotated token for an already linked account but never
// creates a link. Only a verified, completed sign-in may do that, so a file left
// behind by a discarded or superseded attempt cannot become a stored credential.
// The credential file lives in a directory the sandboxed runtime can write, and
// this read happens on the host, outside that sandbox. A link put in place of the
// file, or of its directory, would make this read something else entirely — for
// instance another identity's credential — and seal it into this record. Both
// are refused rather than followed.
function readOwnCredential(paths) {
    try {
        if (!fs.lstatSync(paths.codexHome).isDirectory()) return null;
        if (!fs.lstatSync(paths.authFile).isFile()) return null;
    } catch { return null; }
    let handle;
    try { handle = fs.openSync(paths.authFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch { return null; }
    try {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.size > MAX_AUTH_BYTES) return null;
        return fs.readFileSync(handle, 'utf8');
    } catch { return null; }
    finally { fs.closeSync(handle); }
}

export function seal(ownerKey, connectionId, metadata = {}, { refreshOnly = false, stage = false } = {}) {
    const paths = identityPaths(ownerKey, connectionId);
    const contents = readOwnCredential(paths);
    if (!contents || Buffer.byteLength(contents) > MAX_AUTH_BYTES) return { sealed: false };
    // A file caught mid-write must never replace a usable sealed copy.
    try { JSON.parse(contents); } catch { return { sealed: false }; }
    const existing = readCredentialRecord(ownerKey, connectionId);
    if (refreshOnly && !existing) return { sealed: false };
    const blob = encrypt(contents);
    const next = {
        account_hash: metadata.accountHash ?? existing?.account_hash ?? null,
        account_label: metadata.accountLabel ?? existing?.account_label ?? null,
        plan_type: metadata.planType ?? existing?.plan_type ?? null,
        auth_method: metadata.authMethod ?? existing?.auth_method ?? null,
        // Only a sign-in names itself here; a refresh keeps whatever stored the
        // record, so the attempt that owns a credential stays identifiable.
        login_id: metadata.loginId ?? existing?.login_id ?? null
    };
    // The connection can be deleted by another worker between claiming a sign-in
    // and storing its credential. Its deletion trigger would already have run, so
    // an insert afterwards leaves an orphan whose unique account fingerprint then
    // blocks linking that ChatGPT account anywhere else.
    const store = db.transaction(() => {
        const connection = db.prepare('SELECT data_json FROM ai_connections WHERE id=? AND owner_key=?').get(connectionId, ownerKey);
        if (!connection) return false;
        // The owner can be deactivated, expire or lose Web UI access while a
        // completion is in flight on another worker — an account deletion revokes
        // access before it tears anything down for exactly this reason.
        const account = accountRow(ownerKey);
        if (!account) return false;
        // And the attempt this credential belongs to must still be the one that
        // claimed the identity. A teardown ends claimed attempts, so a sign-in it
        // cancelled cannot store a credential behind it.
        if (metadata.loginId) {
            const attempt = db.prepare('SELECT status,actor_version FROM ai_codex_logins WHERE id=? AND owner_key=? AND connection_id=?')
                .get(metadata.loginId, ownerKey, connectionId);
            if (attempt?.status !== 'sealing') return false;
            // The session that started the sign-in can be revoked while its
            // completion is in flight. A password reset advances the version the
            // attempt recorded, and storing a credential for a revoked session
            // would hand it exactly what the reset took away.
            if (Number.isInteger(attempt.actor_version) && attempt.actor_version !== account.token_version) return false;
        }
        // A disconnect or a deletion is already removing this link. Storing a
        // credential now would put one back behind the teardown, where nothing
        // is watching for it any more.
        try { if (JSON.parse(connection.data_json).teardown) return false; } catch { /* an unreadable payload is not a teardown */ }
        // A sign-in stores its credential beside the record, not over it. Nothing
        // reads a staged row as a link, and a worker that dies before the sign-in
        // is published therefore cannot take the credential that was working with
        // it — the replacement is simply never promoted.
        if (stage) {
            db.prepare(`INSERT INTO ai_codex_credential_stage(owner_key,connection_id,encrypted_blob,account_hash,account_label,plan_type,auth_method,login_id,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(owner_key,connection_id) DO UPDATE SET encrypted_blob=excluded.encrypted_blob,account_hash=excluded.account_hash,
                    account_label=excluded.account_label,plan_type=excluded.plan_type,auth_method=excluded.auth_method,
                    login_id=excluded.login_id,created_at=excluded.created_at`)
                .run(ownerKey, connectionId, blob, next.account_hash, next.account_label, next.plan_type, next.auth_method, next.login_id, Date.now());
            return true;
        }
        db.prepare(`INSERT INTO ai_codex_credentials(owner_key,connection_id,encrypted_blob,account_hash,account_label,plan_type,auth_method,login_id,version,updated_at)
            VALUES(?,?,?,?,?,?,?,?,1,?)
            ON CONFLICT(owner_key,connection_id) DO UPDATE SET encrypted_blob=excluded.encrypted_blob,account_hash=excluded.account_hash,
                account_label=excluded.account_label,plan_type=excluded.plan_type,auth_method=excluded.auth_method,
                login_id=excluded.login_id,version=ai_codex_credentials.version+1,updated_at=excluded.updated_at`)
            .run(ownerKey, connectionId, blob, next.account_hash, next.account_label, next.plan_type, next.auth_method, next.login_id, Date.now());
        return true;
    }).immediate;
    let stored;
    // The one-account rule is enforced by a unique index as well, and that index
    // is what decides a race between two connections signing into the same
    // ChatGPT identity: both can pass the earlier check, only one can store.
    // Reporting that as a storage failure would hide the real reason from the
    // account holder who lost.
    try { stored = store(); }
    catch (error) {
        if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return { sealed: false, reason: 'duplicate' };
        throw error;
    }
    if (!stored) return { sealed: false };
    return { sealed: true, ...next };
}

export function readStagedCredential(ownerKey, connectionId) {
    return db.prepare('SELECT * FROM ai_codex_credential_stage WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId) || null;
}

export function discardStagedCredential(ownerKey, connectionId) {
    db.prepare('DELETE FROM ai_codex_credential_stage WHERE owner_key=? AND connection_id=?').run(ownerKey, connectionId);
}

// Turns a staged sign-in into the connection's link. Only here does a credential
// become the one everything else reads, and only for the attempt that stored it.
// The unique account fingerprint is enforced by this insert, which is what
// decides a race between two connections signing into the same ChatGPT account.
export function promoteStagedCredential(ownerKey, connectionId, loginId) {
    const staged = readStagedCredential(ownerKey, connectionId);
    if (!staged || staged.login_id !== loginId) return { promoted: false };
    try {
        db.prepare(`INSERT INTO ai_codex_credentials(owner_key,connection_id,encrypted_blob,account_hash,account_label,plan_type,auth_method,login_id,version,updated_at)
            VALUES(?,?,?,?,?,?,?,?,1,?)
            ON CONFLICT(owner_key,connection_id) DO UPDATE SET encrypted_blob=excluded.encrypted_blob,account_hash=excluded.account_hash,
                account_label=excluded.account_label,plan_type=excluded.plan_type,auth_method=excluded.auth_method,
                login_id=excluded.login_id,version=ai_codex_credentials.version+1,updated_at=excluded.updated_at`)
            .run(ownerKey, connectionId, staged.encrypted_blob, staged.account_hash, staged.account_label,
                staged.plan_type, staged.auth_method, staged.login_id, Date.now());
    } catch (error) {
        if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) return { promoted: false, reason: 'duplicate' };
        throw error;
    }
    discardStagedCredential(ownerKey, connectionId);
    return { promoted: true };
}

// Drops only the record that makes a connection read as linked, leaving the
// files to a caller that can remove them safely. Used where a credential is
// known to be dead and the identity is still held by the runtime that found out.
export function forgetCredential(ownerKey, connectionId) {
    return db.prepare('DELETE FROM ai_codex_credentials WHERE owner_key=? AND connection_id=?').run(ownerKey, connectionId).changes > 0;
}

// Removes the link itself. The attempt history is deliberately kept so the
// owner still learns why a sign-in was refused or discarded; it is removed by
// its own expiry and by account deletion.
export function wipe(ownerKey, connectionId, { keepLeaseId = null } = {}) {
    db.prepare('DELETE FROM ai_codex_credentials WHERE owner_key=? AND connection_id=?').run(ownerKey, connectionId);
    db.prepare('DELETE FROM ai_codex_credential_stage WHERE owner_key=? AND connection_id=?').run(ownerKey, connectionId);
    // A caller that holds a cleanup reservation keeps it: that row is the only
    // thing keeping a relink off this identity while the files are removed, and
    // dropping it here would let a replacement recreate the directory this call
    // is about to delete. Its owner releases it once the removal is finished.
    if (keepLeaseId) {
        db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id<>?').run(ownerKey, connectionId, keepLeaseId);
    } else {
        db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').run(ownerKey, connectionId);
    }
    fs.rmSync(identityPaths(ownerKey, connectionId).root, { recursive: true, force: true });
}

// Removes the plaintext copy while keeping the sealed record, for a stopped
// runtime whose account stays linked.
export function clearPlaintext(ownerKey, connectionId) {
    const paths = identityPaths(ownerKey, connectionId);
    for (const file of [paths.authFile, `${paths.authFile}.tmp`]) fs.rmSync(file, { force: true });
    fs.rmSync(paths.workDir, { recursive: true, force: true });
}

// A directory is in use while it holds a stored credential, while a sign-in for
// it is still running, or while a worker holds its runtime lease. A sign-in in
// progress has no credential record yet, so leaving it out here would delete the
// directory of an unrelated account in the middle of its sign-in.
function liveDirectories() {
    const now = Date.now();
    const live = new Set();
    const add = row => live.add(`${ownerDirectory(row.owner_key)}/${connectionDirectory(row.owner_key, row.connection_id)}`);
    for (const row of db.prepare('SELECT owner_key,connection_id FROM ai_codex_credentials').all()) add(row);
    for (const row of db.prepare("SELECT owner_key,connection_id FROM ai_codex_logins WHERE status IN ('starting','pending') AND expires_at > ?").all(now)) add(row);
    for (const row of db.prepare('SELECT owner_key,connection_id FROM ai_codex_runtimes WHERE expires_at > ?').all(now)) add(row);
    return live;
}

// A worker that is killed never runs its teardown, so the plaintext credential
// it hydrated stays on disk and would otherwise reach a data-directory backup.
// Any identity whose runtime is no longer leased has no reason to hold one.
// Cleanup takes the identity's runtime lease for the duration of the removal, so
// a worker cannot acquire it and hydrate a credential in the window between
// observing "no lease" and deleting the files. Both sides claim the lease in an
// immediate transaction on the same table, so they serialize.
export function withCleanupLease(ownerKey, connectionId, run) {
    const leaseId = `cleanup-${randomUUID()}`;
    const now = Date.now();
    // An expired lease that still names a sandbox process is not stale. Reaping
    // it here would free the identity for a replacement and then delete the files
    // the orphan is working in. Only a lease whose process is proven gone — or
    // that never had one — may be cleared, and that question is asked of the
    // operating system before the transaction opens.
    const stale = db.prepare('SELECT lease_id,child_pid,expires_at FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId);
    let reapable = null;
    if (stale && stale.expires_at < now) {
        if (stale.child_pid && identityProcessState(stale.child_pid, identityPaths(ownerKey, connectionId).root) !== 'gone') return null;
        reapable = stale.lease_id;
    }
    const claimed = db.transaction(() => {
        if (reapable) {
            db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=? AND expires_at < ?')
                .run(ownerKey, connectionId, reapable, now);
        }
        if (db.prepare('SELECT 1 FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?').get(ownerKey, connectionId)) return false;
        db.prepare('INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(ownerKey, connectionId, leaseId, process.pid, 'cleanup', now + 30000, now);
        return true;
    }).immediate();
    if (!claimed) return null;
    // The lease id is handed to the callback so a removal can keep exactly this
    // reservation alive while it works.
    try { return run(leaseId); }
    finally { db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND lease_id=?').run(ownerKey, connectionId, leaseId); }
}

function clearIdentityPlaintext(ownerKey, connectionId) {
    const paths = identityPaths(ownerKey, connectionId);
    if (!fs.existsSync(paths.authFile) && !fs.existsSync(`${paths.authFile}.tmp`)) return false;
    clearPlaintext(ownerKey, connectionId);
    return true;
}

function clearAbandonedPlaintext() {
    let cleared = 0;
    for (const row of db.prepare('SELECT owner_key,connection_id FROM ai_codex_credentials').all()) {
        if (withCleanupLease(row.owner_key, row.connection_id, () => clearIdentityPlaintext(row.owner_key, row.connection_id))) cleared += 1;
    }
    return cleared;
}

// Removes directories left behind by deleted accounts, deleted connections and
// finished sign-ins, and the plaintext credentials of runtimes that are gone.
// Never removes a directory that is still in use.
export function sweepOrphans() {
    const root = identitiesRoot();
    let owners;
    try { owners = fs.readdirSync(root, { withFileTypes: true }); } catch { return { removed: 0, cleared: 0 }; }
    // Repairs a credential left behind for a connection that no longer exists;
    // its unique account fingerprint would otherwise block a fresh link.
    db.prepare('DELETE FROM ai_codex_credentials WHERE NOT EXISTS (SELECT 1 FROM ai_connections WHERE ai_connections.id=ai_codex_credentials.connection_id AND ai_connections.owner_key=ai_codex_credentials.owner_key)').run();
    const cleared = clearAbandonedPlaintext();
    const live = liveDirectories();
    const liveOwners = new Set([...live].map(entry => entry.slice(0, entry.indexOf('/'))));
    let removed = 0;
    for (const owner of owners) {
        if (!owner.isDirectory()) continue;
        if (!liveOwners.has(owner.name)) {
            fs.rmSync(path.join(root, owner.name), { recursive: true, force: true });
            removed += 1;
            continue;
        }
        let connections;
        try { connections = fs.readdirSync(path.join(root, owner.name), { withFileTypes: true }); } catch { continue; }
        for (const connection of connections) {
            if (!connection.isDirectory() || live.has(`${owner.name}/${connection.name}`)) continue;
            fs.rmSync(path.join(root, owner.name, connection.name), { recursive: true, force: true });
            removed += 1;
        }
    }
    return { removed, cleared };
}

// A worker that died holds no runtime any more. Its leases are released and the
// plaintext credentials it hydrated are removed, because the primary keeps
// running and would otherwise leave the raw token on disk until the whole server
// restarts. Directories are untouched: other workers may be mid-sign-in.
// A process that is gone, or was never recorded. Signalling with 0 only asks
// whether it exists; EPERM means it exists but belongs to someone else, which is
// not a process this manager started.
function processGone(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return true;
    try { process.kill(pid, 0); return false; } catch (error) { return error?.code !== 'EPERM'; }
}

// A recorded pid may have been recycled — across a restart it almost certainly
// was — so it is only ever signalled when the process still looks like this very
// identity's runtime. Every sandbox command carries the identity's own
// directory, which no unrelated process has in its arguments.
// `inspect` is only ever supplied by a test: reading another process's command
// line is exactly the part that differs between hosts, and it has to be possible
// to ask what this decides when the host cannot answer.
// Whether an identity may be taken over: only a process that is really gone
// frees it. One that cannot be identified holds it just as firmly as its own
// runtime does — it simply must not be signalled.
export function identityProcessAlive(ownerKey, connectionId, pid, inspect = processArguments) {
    return identityProcessState(pid, identityPaths(ownerKey, connectionId).root, inspect) !== 'gone';
}

// Three answers, not two. A process that exists but cannot be identified is
// neither this identity's runtime nor gone: the identity stays claimed, and
// nothing is signalled, because a recycled number can belong to any other
// process of this user — a stream, a helper, the manager itself.
function identityProcessState(pid, root, inspect = processArguments) {
    if (processGone(pid)) return 'gone';
    const args = inspect(pid);
    if (args === null) return 'unknown';
    return args.includes(root) ? 'ours' : 'gone';
}

// `/proc` on Linux, because the container image ships BusyBox, whose `ps` has no
// `-p` and would fail — silently turning every live child into an absent one.
// `ps` elsewhere, where there is no `/proc`. A failure to read either is not an
// answer and is reported as such.
function processArguments(pid) {
    if (process.platform === 'linux') {
        try { return fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' '); }
        catch { return null; }
    }
    try {
        const listed = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
        return listed.trim() ? listed : null;
    } catch { return null; }
}

// Ends a sandboxed runtime whose worker died. Its lease is only released once
// the process is really gone: bubblewrap dies with its parent, but the macOS
// backend has no equivalent, so an orphan can outlive the worker that spawned
// it and would otherwise share an identity with its replacement.
async function endOrphan(pid, root, inspect = processArguments) {
    const state = identityProcessState(pid, root, inspect);
    // 'gone' includes a number that now belongs to something else: there is
    // nothing of ours to end, and nothing of anyone else's to touch.
    if (state === 'gone') return true;
    // Not identifiable: keep the identity claimed and send nothing.
    if (state === 'unknown') return false;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
        try { process.kill(pid, signal); } catch { /* it may have exited in between */ }
        for (let waited = 0; waited < (signal === 'SIGTERM' ? 20 : 10); waited += 1) {
            if (processGone(pid)) return true;
            await new Promise(resolve => { const timer = setTimeout(resolve, 100); timer.unref?.(); });
        }
    }
    return processGone(pid);
}

export async function releaseWorkerRuntimes(workerPid, inspect = processArguments) {
    // A worker that died during a sign-in wrote a credential file but never
    // sealed it, so it has no record for the credential-driven pass to find. Its
    // own leases are the only trace of those identities.
    const held = db.prepare('SELECT owner_key,connection_id,child_pid FROM ai_codex_runtimes WHERE worker_pid=?').all(workerPid);
    let leases = 0;
    let cleared = 0;
    let retained = 0;
    for (const row of held) {
        // The identity stays claimed while its process lives. Handing it on now
        // would let a replacement hydrate the same credential beside an orphan
        // that is still running on it.
        if (!(await endOrphan(row.child_pid, identityPaths(row.owner_key, row.connection_id).root, inspect))) {
            db.prepare("UPDATE ai_codex_runtimes SET state='revoked', expires_at=?, updated_at=? WHERE owner_key=? AND connection_id=? AND worker_pid=?")
                .run(Date.now() + ORPHAN_HOLD_MS, Date.now(), row.owner_key, row.connection_id, workerPid);
            retained += 1;
            continue;
        }
        // Releasing the dead worker's lease and taking the cleanup lease happen in
        // one step, so no other worker can slip in and hydrate between them.
        const replaced = db.transaction(() => {
            const removed = db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND worker_pid=?')
                .run(row.owner_key, row.connection_id, workerPid).changes;
            if (!removed) return 0;
            db.prepare('INSERT INTO ai_codex_runtimes(owner_key,connection_id,lease_id,worker_pid,state,expires_at,updated_at) VALUES(?,?,?,?,?,?,?)')
                .run(row.owner_key, row.connection_id, `cleanup-${randomUUID()}`, process.pid, 'cleanup', Date.now() + 30000, Date.now());
            return removed;
        }).immediate();
        if (!replaced) continue;
        leases += replaced;
        try { if (clearIdentityPlaintext(row.owner_key, row.connection_id)) cleared += 1; }
        finally { db.prepare("DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=? AND state='cleanup'").run(row.owner_key, row.connection_id); }
    }
    // Anything still recorded for that worker either had no process of its own or
    // has just been confirmed gone; a retained lease was marked revoked above and
    // is left alone, to expire once nothing refreshes it.
    leases += db.prepare("DELETE FROM ai_codex_runtimes WHERE worker_pid=? AND state<>'revoked'").run(workerPid).changes;
    return { leases, retained, cleared: cleared + clearAbandonedPlaintext() };
}

// No sign-in and no runtime lease survives a restart: a device-code attempt
// lives only in the worker that started it. Called once by the primary process
// before workers start, so the following sweep sees an accurate live set.
export async function resetInterruptedRuntimes() {
    const logins = db.prepare("UPDATE ai_codex_logins SET status='failed', error_code='ai_codex_login_interrupted', updated_at=? WHERE status IN ('starting','pending')")
        .run(Date.now()).changes;
    // A primary that was killed rather than drained leaves its sandbox children
    // behind on a backend that does not tie them to their parent. Releasing those
    // leases before the processes are gone would hand a live identity to the
    // worker that starts next, and the sweep below could delete files underneath
    // it.
    let retained = 0;
    let reaped = 0;
    for (const row of db.prepare('SELECT owner_key,connection_id,child_pid FROM ai_codex_runtimes WHERE child_pid IS NOT NULL').all()) {
        if (await endOrphan(row.child_pid, identityPaths(row.owner_key, row.connection_id).root)) {
            reaped += db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=? AND connection_id=?')
                .run(row.owner_key, row.connection_id).changes;
            continue;
        }
        // Pushed forward as well: an expiry from before the restart is already in
        // the past, and a lease that looks expired is one an acquisition would
        // otherwise be free to sweep.
        db.prepare("UPDATE ai_codex_runtimes SET state='revoked', expires_at=?, updated_at=? WHERE owner_key=? AND connection_id=?")
            .run(Date.now() + ORPHAN_HOLD_MS, Date.now(), row.owner_key, row.connection_id);
        retained += 1;
    }
    const leases = reaped + db.prepare("DELETE FROM ai_codex_runtimes WHERE state<>'revoked'").run().changes;
    return { logins, leases, retained };
}

// Deleting an account removes exactly its own tree. A global sweep here would
// also delete the directory of an account that is signing in right now.
export function purgeIdentity(ownerKey) {
    db.prepare('DELETE FROM ai_codex_credentials WHERE owner_key=?').run(ownerKey);
    db.prepare('DELETE FROM ai_codex_credential_stage WHERE owner_key=?').run(ownerKey);
    db.prepare('DELETE FROM ai_codex_logins WHERE owner_key=?').run(ownerKey);
    db.prepare('DELETE FROM ai_codex_runtimes WHERE owner_key=?').run(ownerKey);
    fs.rmSync(path.join(identitiesRoot(), ownerDirectory(ownerKey)), { recursive: true, force: true });
}
