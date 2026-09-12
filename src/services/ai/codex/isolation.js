import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from '../../../config/constants.js';
import { codexConfig } from './config.js';

const run = promisify(execFile);

// A Codex runtime is an execution-capable agent host. A prompt, a read-only
// filesystem mode or a disabled tool flag are defence in depth, never the
// boundary. Every runtime therefore starts inside an operating-system sandbox
// whose containment is proven by a canary self-test before the adapter is
// offered at all.
//
// grade `isolated`  – kernel-enforced namespace/mount isolation (bubblewrap).
// grade `development` – best effort only (macOS seatbelt); refused for hosted
//                       multi-user operation unless an operator opts in.
// grade `none`      – no enforceable boundary; the adapter stays disabled.
const BACKENDS = ['bwrap', 'sandbox-exec'];

const READ_ONLY_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc/ssl', '/etc/pki',
    '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/System', '/private/var/db/timezone'];
const STANDARD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
// Only the Codex distribution's own package tree is ever mounted whole. A
// launcher that resolves into an application or monorepo package must not carry
// that package's other files, such as a `.env` or an `.npmrc`, into the sandbox.
const CODEX_PACKAGE = '@openai/codex';

const realPath = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
// Two paths overlap when either contains the other. A mount that contains the
// data directory would expose it just as surely as one inside it.
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

let cached = null;

export function which(binary) {
    // A configured path is resolved against the manager's working directory
    // here, because the sandbox executes from the identity's own work directory
    // where a relative path no longer exists.
    if (binary.includes('/')) {
        const resolved = path.resolve(binary);
        return fs.existsSync(resolved) ? resolved : null;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, binary);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep searching */ }
    }
    return null;
}

function isCodexPackage(directory) {
    try {
        const name = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))?.name;
        if (typeof name !== 'string') return false;
        return name === CODEX_PACKAGE || name.startsWith(`${CODEX_PACKAGE}-`) || name.startsWith(`${CODEX_PACKAGE}/`);
    } catch { return false; }
}

// A launcher with a `#!` line needs its interpreter inside the sandbox as well.
// An npm-installed Codex uses `/usr/bin/env node`, and the Node that runs it is
// routinely outside the standard system directories.
export function launcherInterpreter(binary) {
    let header = '';
    try {
        const handle = fs.openSync(binary, 'r');
        try {
            const buffer = Buffer.alloc(256);
            header = buffer.subarray(0, fs.readSync(handle, buffer, 0, 256, 0)).toString('utf8');
        } finally { fs.closeSync(handle); }
    } catch { return null; }
    if (!header.startsWith('#!')) return null;
    return /(^|[\s/])node[0-9.]*(\s|$)/.test(header.split('\n')[0]) ? path.dirname(process.execPath) : null;
}

// What the launcher itself needs inside the namespace, kept as narrow as
// possible: the executable file, the file a symlink points at, and its
// interpreter — never their directories, because a launcher commonly sits beside
// unrelated application files such as a mounted `.env` or an `.npmrc`. Only a
// resolved package tree is bound as a directory, because a packaged launcher
// genuinely needs the files it ships with.
export function launcherMounts(binary) {
    if (!binary) return [];
    const mounts = [binary];
    const interpreter = launcherInterpreter(binary);
    if (interpreter) mounts.push(process.execPath);
    const real = realPath(binary);
    if (real !== binary) {
        mounts.push(real);
        // Walk up to the package root so a launcher's sibling files and vendored
        // binaries come with it.
        let candidate = path.dirname(real);
        for (let depth = 0; depth < 6; depth += 1) {
            const parent = path.dirname(candidate);
            if (parent === candidate) break;
            if (fs.existsSync(path.join(candidate, 'package.json'))) {
                // The first package boundary is the answer either way; an
                // unrecognized one is simply not mounted, so a launcher inside it
                // fails visibly instead of exposing its neighbours.
                if (isCodexPackage(candidate)) mounts.push(candidate);
                break;
            }
            candidate = parent;
        }
    }
    return [...new Set(mounts)];
}

// A launcher placed in or above the manager's data directory cannot be mounted
// without handing the runtime the database, the encryption key and every other
// identity. That configuration is refused rather than silently contained.
export function unsafeLauncherMounts(binary) {
    const dataDirectory = realPath(DATA_DIR);
    return launcherMounts(binary).filter(mount => overlaps(realPath(mount), dataDirectory));
}

// Directories the launcher needs on PATH. The version probe and the sandboxed
// launch use the same list, so a launcher the probe can start is one the sandbox
// can start too.
export function launcherPath(binary) {
    if (!binary) return [...STANDARD_PATH];
    // Only the launcher's and interpreter's own directories, which contain
    // nothing else inside the namespace because the binds above are file-level.
    const extra = [path.dirname(binary), launcherInterpreter(binary)]
        .filter(directory => directory && !STANDARD_PATH.includes(directory));
    return [...new Set([...extra, ...STANDARD_PATH])];
}

// Built from scratch: nothing from the host profile is inherited, so an
// operator's `OPENAI_API_KEY`, proxy settings, CODEX_HOME, plugin roots or
// manager secrets can never reach the runtime. `extraPath` only ever holds the
// launcher's own directory, which has to be executable for it to start at all.
export function sandboxEnvironment(codexHome, workDir, extraPath = []) {
    return {
        PATH: [...new Set([...extraPath, ...STANDARD_PATH])].join(':'),
        HOME: codexHome,
        CODEX_HOME: codexHome,
        TMPDIR: path.join(workDir, 'tmp'),
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        // Codex reads this to decide whether a terminal UI is attached.
        TERM: 'dumb'
    };
}

function existingReadOnlyRoots() {
    return READ_ONLY_ROOTS.filter(root => {
        try { fs.statSync(root); return true; } catch { return false; }
    });
}

function bwrapArguments(bwrap, { codexHome, workDir, environment, command, launcher }) {
    const args = [
        '--die-with-parent', '--new-session', '--clearenv',
        '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var'
    ];
    const roots = existingReadOnlyRoots();
    for (const root of roots) args.push('--ro-bind', root, root);
    // A data directory that happens to live under one of those roots would be
    // carried in by that bind, with the database and the key files in it. Masking
    // it makes the layout irrelevant; the identity binds below are applied
    // afterwards, so a runtime directory inside it stays reachable.
    for (const directory of new Set([path.resolve(DATA_DIR), realPath(DATA_DIR)])) args.push('--tmpfs', directory);
    // The runtime is launched by absolute path. Its directory, the target of a
    // symlinked launcher and that target's package root are bound read-only when
    // they live outside the standard roots, so a global npm install or an
    // install under /opt stays reachable inside the namespace.
    const covered = directory => roots.some(root => directory === root || directory.startsWith(`${root}/`));
    const dataDirectory = realPath(DATA_DIR);
    for (const mount of launcherMounts(launcher)) {
        // Belt and braces: availability already refuses such a launcher, so this
        // can only drop a mount that must never exist.
        if (overlaps(realPath(mount), dataDirectory)) continue;
        if (!covered(mount)) args.push('--ro-bind-try', mount, mount);
    }
    // Only the identity's own runtime tree is writable. The manager's data
    // directory, .env, key files, other identities and any container socket are
    // simply absent from the mount namespace.
    args.push('--bind', codexHome, codexHome, '--bind', workDir, workDir, '--chdir', workDir);
    for (const [key, value] of Object.entries(environment)) args.push('--setenv', key, value);
    return { file: bwrap, args: [...args, '--', ...command] };
}

function seatbeltProfile({ codexHome, workDir }) {
    // Seatbelt matches the kernel's resolved path, so every rule lists the given
    // path and its real path; on macOS the temporary and data directories are
    // routinely reached through a symlink.
    const variants = value => {
        const resolved = path.resolve(value);
        const real = (() => { try { return fs.realpathSync.native(resolved); } catch { return resolved; } })();
        return [...new Set([resolved, real])];
    };
    const literal = value => variants(value).map(item => `(literal ${JSON.stringify(item)})`).join(' ');
    const subpath = value => variants(value).map(item => `(subpath ${JSON.stringify(item)})`).join(' ');
    // Seatbelt applies the last matching rule, so the order is deliberate: deny
    // every write and every read of the manager's data directory first, then
    // re-allow exactly this identity's own tree. That keeps the runtime usable
    // even when its directory lives under the data directory, which is the
    // default, while every neighbouring identity and every secret stays out of
    // reach. The runtime's TMPDIR already points inside its own tree, so the
    // host temporary directory is never opened up.
    //
    // Deliberately limited: this profile starts from `allow default`, so reads
    // outside the data directory and execution of other binaries remain
    // possible. It is graded `development` and refused for hosted multi-user
    // operation for exactly that reason. No partial process-exec denial is
    // written here, because an allowlist-shaped rule that is trivially bypassed
    // by another install path would only look protective.
    return `(version 1)
(allow default)
(deny file-write*)
(deny file-read* ${subpath(DATA_DIR)})
(allow file-read* ${subpath(codexHome)} ${subpath(workDir)})
(allow file-write* ${subpath(codexHome)} ${subpath(workDir)})
(deny file-read* ${literal(path.join(DATA_DIR, '.env'))} ${literal(path.join(DATA_DIR, 'secret.key'))} ${literal(path.join(DATA_DIR, 'jwt.secret'))})
`;
}

function seatbeltArguments(sandboxExec, { codexHome, workDir, environment, command }) {
    const profile = path.join(codexHome, 'sandbox.sb');
    fs.writeFileSync(profile, seatbeltProfile({ codexHome, workDir }), { mode: 0o600 });
    return { file: sandboxExec, args: ['-f', profile, ...command], environment };
}

// Wraps a command so it runs inside the detected sandbox. The returned spawn
// description never inherits the host environment.
// `launcher` is the configured runtime. It defaults to the command being run, and
// is passed explicitly by the containment self-test so the probe carries exactly
// the mounts a real launch would.
export function wrapCommand(backend, { codexHome, workDir, command, launcher = command?.[0] }) {
    const environment = sandboxEnvironment(codexHome, workDir, launcherPath(launcher));
    if (backend.name === 'bwrap') return { ...bwrapArguments(backend.path, { codexHome, workDir, environment, command, launcher }), environment: {} };
    if (backend.name === 'sandbox-exec') return seatbeltArguments(backend.path, { codexHome, workDir, environment, command });
    throw Object.assign(new Error('AI_CODEX_SANDBOX_UNAVAILABLE'), { code: 'AI_CODEX_SANDBOX_UNAVAILABLE' });
}

// Proves containment instead of assuming it: a canary file outside the sandbox
// must be unreadable and the manager's data directory must be unwritable.
async function selfTest(backend, runtimeDir, launcher) {
    const probeRoot = fs.mkdtempSync(path.join(runtimeDir, 'probe-'));
    const codexHome = path.join(probeRoot, 'home');
    const workDir = path.join(probeRoot, 'work');
    for (const dir of [codexHome, workDir, path.join(workDir, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString('hex');
    // One canary beside the runtime directory and one in the data directory
    // itself: a layout where the data directory is reachable through a system
    // root would otherwise pass a probe that only reads the first.
    const canaries = [...new Set([path.join(runtimeDir, `canary-${token}`), path.join(DATA_DIR, `.codex-read-probe-${token}`)])];
    for (const canary of canaries) fs.writeFileSync(canary, token, { mode: 0o600 });
    const forbidden = path.join(DATA_DIR, `.codex-write-probe-${token}`);
    const script = `${canaries.map(canary => `cat ${JSON.stringify(canary)} 2>/dev/null;`).join(' ')} printf "|"; ` +
        `(printf x > ${JSON.stringify(forbidden)}) 2>/dev/null && printf WROTE; printf "|done"`;
    try {
        // Carries the configured launcher's mounts, so a launcher whose location
        // would expose the data directory fails the canary rather than slipping
        // past a probe built only around /bin/sh.
        const spawnDescription = wrapCommand(backend, { codexHome, workDir, command: ['/bin/sh', '-c', script], launcher });
        const { stdout } = await run(spawnDescription.file, spawnDescription.args,
            { env: spawnDescription.environment, timeout: 15000, maxBuffer: 64 * 1024 });
        if (!stdout.includes('|done')) return { ok: false, reason: 'AI_CODEX_SANDBOX_PROBE_FAILED' };
        if (stdout.includes(token)) return { ok: false, reason: 'AI_CODEX_SANDBOX_READ_ESCAPE' };
        if (stdout.includes('WROTE')) return { ok: false, reason: 'AI_CODEX_SANDBOX_WRITE_ESCAPE' };
        return { ok: true };
    } catch {
        return { ok: false, reason: 'AI_CODEX_SANDBOX_PROBE_FAILED' };
    } finally {
        for (const canary of canaries) fs.rmSync(canary, { force: true });
        fs.rmSync(forbidden, { force: true });
        fs.rmSync(probeRoot, { recursive: true, force: true });
    }
}

function candidates(requested) {
    if (requested === 'none') return [];
    if (requested !== 'auto') return BACKENDS.includes(requested) ? [requested] : [];
    return process.platform === 'linux' ? ['bwrap'] : process.platform === 'darwin' ? ['sandbox-exec'] : [];
}

// The readiness probe and the sandboxed launch must use the same executable.
// Resolving once, to an absolute path, prevents the case where the probe finds
// `codex` on the host PATH while the sandbox's narrow PATH cannot.
export function resolveCodexBinary(binary) {
    return which(binary);
}

// Resolves the isolation backend once per process. A failure is a stable reason
// code, never a silent downgrade to an unsandboxed runtime.
export async function resolveIsolation({ force = false } = {}) {
    if (cached && !force) return cached;
    const config = codexConfig();
    fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
    for (const name of candidates(config.sandbox)) {
        const resolved = which(name);
        if (!resolved) continue;
        const backend = { name, path: resolved, grade: name === 'bwrap' ? 'isolated' : 'development' };
        const probe = await selfTest(backend, config.runtimeDir, which(config.binary));
        if (!probe.ok) { cached = { available: false, reason: probe.reason, backend: name }; return cached; }
        if (backend.grade === 'development' && !config.allowDevelopmentSandbox) {
            cached = { available: false, reason: 'AI_CODEX_SANDBOX_GRADE_REJECTED', backend: name, grade: backend.grade };
            return cached;
        }
        cached = { available: true, backend: name, grade: backend.grade, handle: backend };
        return cached;
    }
    cached = { available: false, reason: config.sandbox === 'none' ? 'AI_CODEX_SANDBOX_DISABLED' : 'AI_CODEX_SANDBOX_MISSING' };
    return cached;
}

export function resetIsolationCache() { cached = null; }
