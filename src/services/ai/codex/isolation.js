import { execFile, execFileSync } from 'node:child_process';
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

let cached = null;

function which(binary) {
    if (binary.includes('/')) return fs.existsSync(binary) ? binary : null;
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, binary);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep searching */ }
    }
    return null;
}

// Built from scratch: nothing from the host profile is inherited, so an
// operator's `OPENAI_API_KEY`, proxy settings, CODEX_HOME, plugin roots or
// manager secrets can never reach the runtime.
export function sandboxEnvironment(codexHome, workDir) {
    return {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
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

function bwrapArguments(bwrap, { codexHome, workDir, environment, command }) {
    const args = [
        '--die-with-parent', '--new-session', '--clearenv',
        '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/var'
    ];
    for (const root of existingReadOnlyRoots()) args.push('--ro-bind', root, root);
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
    return `(version 1)
(allow default)
(deny file-write*)
(deny file-read* ${subpath(DATA_DIR)})
(allow file-read* ${subpath(codexHome)} ${subpath(workDir)})
(allow file-write* ${subpath(codexHome)} ${subpath(workDir)})
(deny file-read* ${literal(path.join(DATA_DIR, '.env'))} ${literal(path.join(DATA_DIR, 'secret.key'))} ${literal(path.join(DATA_DIR, 'jwt.secret'))})
(deny process-exec* (literal "/usr/bin/docker") (literal "/usr/local/bin/docker"))
`;
}

function seatbeltArguments(sandboxExec, { codexHome, workDir, environment, command }) {
    const profile = path.join(codexHome, 'sandbox.sb');
    fs.writeFileSync(profile, seatbeltProfile({ codexHome, workDir }), { mode: 0o600 });
    return { file: sandboxExec, args: ['-f', profile, ...command], environment };
}

// Wraps a command so it runs inside the detected sandbox. The returned spawn
// description never inherits the host environment.
export function wrapCommand(backend, { codexHome, workDir, command }) {
    const environment = sandboxEnvironment(codexHome, workDir);
    if (backend.name === 'bwrap') return { ...bwrapArguments(backend.path, { codexHome, workDir, environment, command }), environment: {} };
    if (backend.name === 'sandbox-exec') return seatbeltArguments(backend.path, { codexHome, workDir, environment, command });
    throw Object.assign(new Error('AI_CODEX_SANDBOX_UNAVAILABLE'), { code: 'AI_CODEX_SANDBOX_UNAVAILABLE' });
}

// Proves containment instead of assuming it: a canary file outside the sandbox
// must be unreadable and the manager's data directory must be unwritable.
async function selfTest(backend, runtimeDir) {
    const probeRoot = fs.mkdtempSync(path.join(runtimeDir, 'probe-'));
    const codexHome = path.join(probeRoot, 'home');
    const workDir = path.join(probeRoot, 'work');
    for (const dir of [codexHome, workDir, path.join(workDir, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString('hex');
    const canary = path.join(runtimeDir, `canary-${token}`);
    fs.writeFileSync(canary, token, { mode: 0o600 });
    const forbidden = path.join(DATA_DIR, `.codex-write-probe-${token}`);
    const script = `cat ${JSON.stringify(canary)} 2>/dev/null; printf "|"; ` +
        `(printf x > ${JSON.stringify(forbidden)}) 2>/dev/null && printf WROTE; printf "|done"`;
    try {
        const spawnDescription = wrapCommand(backend, { codexHome, workDir, command: ['/bin/sh', '-c', script] });
        const { stdout } = await run(spawnDescription.file, spawnDescription.args,
            { env: spawnDescription.environment, timeout: 15000, maxBuffer: 64 * 1024 });
        if (!stdout.includes('|done')) return { ok: false, reason: 'AI_CODEX_SANDBOX_PROBE_FAILED' };
        if (stdout.includes(token)) return { ok: false, reason: 'AI_CODEX_SANDBOX_READ_ESCAPE' };
        if (stdout.includes('WROTE')) return { ok: false, reason: 'AI_CODEX_SANDBOX_WRITE_ESCAPE' };
        return { ok: true };
    } catch {
        return { ok: false, reason: 'AI_CODEX_SANDBOX_PROBE_FAILED' };
    } finally {
        fs.rmSync(canary, { force: true });
        fs.rmSync(forbidden, { force: true });
        fs.rmSync(probeRoot, { recursive: true, force: true });
    }
}

function candidates(requested) {
    if (requested === 'none') return [];
    if (requested !== 'auto') return BACKENDS.includes(requested) ? [requested] : [];
    return process.platform === 'linux' ? ['bwrap'] : process.platform === 'darwin' ? ['sandbox-exec'] : [];
}

export function codexVersion(binary) {
    try {
        const output = execFileSync(binary, ['--version'], { timeout: 10000, encoding: 'utf8', env: { PATH: process.env.PATH || '' } });
        return output.trim().match(/(\d+\.\d+\.\d+)/)?.[1] || null;
    } catch { return null; }
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
        const probe = await selfTest(backend, config.runtimeDir);
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
