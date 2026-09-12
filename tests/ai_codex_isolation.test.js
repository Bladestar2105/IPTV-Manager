import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Exercises the real isolation backend, not a stand-in. Containment is asserted
// by trying to escape it: a canary outside the sandbox must stay unreadable and
// the manager's data directory must stay unwritable. Where the host provides no
// usable backend, the suite asserts that the adapter reports itself unavailable
// and records the missing precondition instead of passing quietly.
const run = promisify(execFile);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-codex-isolation-'));
const runtimeDir = path.join(dataDir, 'ai-codex');
process.env.DATA_DIR = dataDir;
process.env.AI_CODEX_RUNTIME_DIR = runtimeDir;

// Resolved at module scope: the containment cases are skipped by value, and a
// value produced in `beforeAll` would not be known when the suite is collected.
process.env.AI_CODEX_SANDBOX = 'auto';
process.env.AI_CODEX_ALLOW_DEV_SANDBOX = 'true';
const isolation = await import('../src/services/ai/codex/isolation.js');
const runtime = await import('../src/services/ai/codex/runtime.js');
isolation.resetIsolationCache();
const detected = await isolation.resolveIsolation({ force: true });
if (!detected.available) {
    // Recorded on purpose: an environment without a usable backend leaves the
    // containment evidence outstanding for the pilot acceptance.
    console.warn(`[ai-codex] no usable isolation backend on this host: ${detected.reason}. Containment assertions are reported as an unmet precondition.`);
}

function identity(name) {
    const root = path.join(runtimeDir, 'probe-identities', name);
    const codexHome = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    for (const dir of [codexHome, workDir, path.join(workDir, 'tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { root, codexHome, workDir };
}

// Every read probe carries a control file inside the identity's own tree. A
// sandbox that stops the command from running at all — a denied redirect used to
// do exactly that — would otherwise satisfy every "must not contain" assertion
// without reading anything.
function control(paths) {
    const marker = `control-${randomBytes(8).toString('hex')}`;
    const file = path.join(paths.workDir, 'control');
    fs.writeFileSync(file, marker, { mode: 0o600 });
    return { marker, read: `cat ${JSON.stringify(file)};` };
}

async function inSandbox(paths, script) {
    const description = isolation.wrapCommand(detected.handle, { ...paths, command: ['/bin/sh', '-c', script] });
    try {
        const { stdout } = await run(description.file, description.args, { env: description.environment, timeout: 20000, maxBuffer: 64 * 1024 });
        return stdout;
    } catch (error) { return `ERROR:${error.message}`; }
}

afterAll(() => {
    for (const key of ['AI_CODEX_SANDBOX', 'AI_CODEX_ALLOW_DEV_SANDBOX', 'AI_CODEX_ENABLED', 'AI_CODEX_BIN']) delete process.env[key];
    fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => { isolation.resetIsolationCache(); });

describe('Codex runtime environment', () => {
    it('builds the runtime environment from scratch and inherits nothing', () => {
        process.env.OPENAI_API_KEY = 'inherited-platform-key';
        process.env.OPENAI_BASE_URL = 'https://inherited.example/v1';
        process.env.CODEX_HOME = '/home/operator/.codex';
        try {
            const paths = identity('env-check');
            const environment = isolation.sandboxEnvironment(paths.codexHome, paths.workDir);
            expect(Object.keys(environment).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR']);
            expect(environment.CODEX_HOME).toBe(paths.codexHome);
            expect(environment.HOME).toBe(paths.codexHome);
            expect(environment.TMPDIR.startsWith(paths.workDir)).toBe(true);
            expect(JSON.stringify(environment)).not.toContain('inherited-platform-key');
            expect(JSON.stringify(environment)).not.toContain('inherited.example');
            expect(environment.PATH).not.toContain(process.cwd());
        } finally {
            delete process.env.OPENAI_API_KEY;
            delete process.env.OPENAI_BASE_URL;
            delete process.env.CODEX_HOME;
        }
    });
});

describe('Codex launcher location and interpreter', () => {
    it('refuses a launcher that cannot be mounted without exposing the data directory', () => {
        const inside = path.join(dataDir, 'codex');
        fs.writeFileSync(inside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        // Binding its directory would hand the runtime db.sqlite, secret.key and
        // every identity directory.
        expect(isolation.unsafeLauncherMounts(inside)).toContain(inside);
        const nested = path.join(dataDir, 'bin', 'codex');
        fs.mkdirSync(path.dirname(nested), { recursive: true });
        fs.writeFileSync(nested, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        expect(isolation.unsafeLauncherMounts(nested).length).toBeGreaterThan(0);
        // A launcher in a normal system location stays acceptable.
        expect(isolation.unsafeLauncherMounts('/bin/sh')).toEqual([]);
    });

    it('keeps the interpreter of a script launcher reachable for the probe and the sandbox', () => {
        const scripted = path.join(runtimeDir, 'npm-style-codex');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(scripted, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 });
        const nodeDirectory = path.dirname(process.execPath);
        // An npm install uses `env node`, and Node commonly lives outside the
        // four standard directories, so both the probe PATH and the sandbox PATH
        // must keep it.
        expect(isolation.launcherInterpreter(scripted)).toBe(nodeDirectory);
        expect(isolation.launcherPath(scripted)).toContain(nodeDirectory);
        // The interpreter is bound as a file, not as its whole directory.
        expect(isolation.launcherMounts(scripted)).toContain(process.execPath);
        expect(isolation.launcherMounts(scripted)).not.toContain(nodeDirectory);
        expect(isolation.sandboxEnvironment('/tmp/home', '/tmp/work', isolation.launcherPath(scripted)).PATH.split(':'))
            .toContain(nodeDirectory);
        // A compiled launcher needs no interpreter and gets no extra directory.
        expect(isolation.launcherInterpreter('/bin/sh')).toBeNull();
        expect(isolation.launcherPath('/bin/sh')).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    });

    it('never binds a launcher directory that holds unrelated application files', () => {
        const serviceDirectory = path.join(runtimeDir, 'service');
        fs.mkdirSync(serviceDirectory, { recursive: true });
        const launcher = path.join(serviceDirectory, 'codex');
        fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(path.join(serviceDirectory, '.env'), 'SECRET=value\n', { mode: 0o600 });
        const mounts = isolation.launcherMounts(launcher);
        // Binding the directory would carry the sibling secret into the sandbox.
        expect(mounts).toContain(launcher);
        expect(mounts).not.toContain(serviceDirectory);
        expect(mounts.every(mount => !mount.endsWith('.env'))).toBe(true);
    });

    it('binds the Codex package of a directly configured entrypoint', () => {
        // A documented installation points `AI_CODEX_BIN` straight at the
        // package's entrypoint instead of at a `.bin` symlink. Without the
        // package root the vendored executable beside it stays hidden by the
        // application mask, and the sandboxed version probe fails.
        fs.mkdirSync(runtimeDir, { recursive: true });
        // Built under the resolved runtime directory on purpose: the whole point
        // is a configured path that is already canonical, so the symlink branch
        // that used to be the only caller of the package walk never runs.
        const packageRoot = path.join(fs.realpathSync.native(runtimeDir), 'pkg', 'node_modules', '@openai', 'codex');
        const entrypoint = path.join(packageRoot, 'bin', 'codex.js');
        fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.154.0' }));
        fs.writeFileSync(entrypoint, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 });
        expect(fs.realpathSync.native(entrypoint)).toBe(entrypoint);
        const mounts = isolation.launcherMounts(entrypoint);
        expect(mounts).toContain(entrypoint);
        expect(mounts).toContain(packageRoot);
        // Still only the Codex package: an application package around a launcher
        // is never bound whole.
        const foreignRoot = path.join(fs.realpathSync.native(runtimeDir), 'app');
        const foreign = path.join(foreignRoot, 'bin', 'codex.js');
        fs.mkdirSync(path.dirname(foreign), { recursive: true });
        fs.writeFileSync(path.join(foreignRoot, 'package.json'), JSON.stringify({ name: 'iptv-manager' }));
        fs.writeFileSync(path.join(foreignRoot, '.env'), 'SECRET=value\n', { mode: 0o600 });
        fs.writeFileSync(foreign, '#!/usr/bin/env node\nprocess.exit(0)\n', { mode: 0o755 });
        expect(isolation.launcherMounts(foreign)).not.toContain(foreignRoot);
    });
});

describe('Codex namespace layout', () => {
    it('masks the data directory even when it sits under a mounted system root', () => {
        const paths = identity('mask-check');
        const wrapped = isolation.wrapCommand({ name: 'bwrap', path: '/usr/bin/bwrap', grade: 'isolated' },
            { ...paths, command: ['/bin/sh', '-c', 'true'] });
        const args = wrapped.args;
        const tmpfsAt = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === fs.realpathSync.native(dataDir));
        const bindAt = args.findIndex((value, index) => value === '--bind' && args[index + 1] === paths.codexHome);
        expect(tmpfsAt).toBeGreaterThan(-1);
        // The application's own tree is masked as well: a bare-metal install under
        // a bound system root would otherwise expose its `.env`.
        const masked = new Set(args.filter((value, index) => args[index - 1] === '--tmpfs'));
        for (const root of isolation.maskedRoots()) expect(masked).toContain(root);
        expect(masked).toContain(fs.realpathSync.native(process.cwd()));
        // Masked after the read-only roots and before the identity binds, so a
        // data directory under /usr is hidden while the runtime tree stays usable.
        expect(bindAt).toBeGreaterThan(tmpfsAt);
        expect(args.slice(0, tmpfsAt)).toContain('--ro-bind');
    });

    it('rebinds a launcher that one of those masks would hide', () => {
        // The documented bare-metal layout: a local install inside the
        // application tree. `/usr`-style root binds do not cover it, because the
        // mask above hides it again — it has to be bound after the masks.
        const paths = identity('masked-launcher');
        const launcher = path.join(process.cwd(), 'node_modules', '.bin', 'codex-probe');
        fs.mkdirSync(path.dirname(launcher), { recursive: true });
        fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        try {
            const args = isolation.wrapCommand({ name: 'bwrap', path: '/usr/bin/bwrap', grade: 'isolated' },
                { ...paths, command: [launcher], launcher }).args;
            const maskAt = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === fs.realpathSync.native(process.cwd()));
            const rebindAt = args.findIndex((value, index) => value === '--ro-bind-try' && args[index + 1] === launcher);
            expect(maskAt).toBeGreaterThan(-1);
            expect(rebindAt).toBeGreaterThan(maskAt);
        } finally { fs.rmSync(launcher, { force: true }); }
    });
});

describe('Codex isolation backend selection', () => {
    it('keeps the adapter unavailable when sandboxing is switched off', async () => {
        process.env.AI_CODEX_SANDBOX = 'none';
        const result = await isolation.resolveIsolation({ force: true });
        expect(result).toMatchObject({ available: false, reason: 'AI_CODEX_SANDBOX_DISABLED' });
        expect(() => isolation.wrapCommand({ name: 'none' }, { codexHome: '/tmp', workDir: '/tmp', command: ['/bin/sh'] }))
            .toThrow(/AI_CODEX_SANDBOX_UNAVAILABLE/);
        process.env.AI_CODEX_SANDBOX = 'auto';
    });

    it('keeps the adapter unavailable when the requested backend is unknown or absent', async () => {
        process.env.AI_CODEX_SANDBOX = 'definitely-not-a-backend';
        expect(await isolation.resolveIsolation({ force: true })).toMatchObject({ available: false, reason: 'AI_CODEX_SANDBOX_MISSING' });
        process.env.AI_CODEX_SANDBOX = 'auto';
    });

    it('refuses a development-grade backend unless an operator opted in', async () => {
        delete process.env.AI_CODEX_ALLOW_DEV_SANDBOX;
        const result = await isolation.resolveIsolation({ force: true });
        process.env.AI_CODEX_ALLOW_DEV_SANDBOX = 'true';
        if (detected.available && detected.grade === 'development') {
            expect(result).toMatchObject({ available: false, reason: 'AI_CODEX_SANDBOX_GRADE_REJECTED' });
        } else {
            expect(result.available).toBe(detected.available);
        }
    });

    it('never reports the adapter as available without a proven backend', async () => {
        process.env.AI_CODEX_ENABLED = 'true';
        process.env.AI_CODEX_SANDBOX = 'none';
        const availability = await runtime.codexAvailability({ force: true });
        expect(availability.available).toBe(false);
        expect(['AI_CODEX_SANDBOX_DISABLED', 'AI_CODEX_BINARY_MISSING', 'AI_CODEX_VERSION_UNSUPPORTED']).toContain(availability.reason);
        process.env.AI_CODEX_SANDBOX = 'auto';
        delete process.env.AI_CODEX_ENABLED;
    });
});

describe('Codex isolation containment', () => {
    it('reports the detected backend and its grade', () => {
        expect(detected).toHaveProperty('available');
        if (detected.available) expect(['isolated', 'development']).toContain(detected.grade);
        else expect(typeof detected.reason).toBe('string');
    });

    it.skipIf(!detected?.available)('cannot read a file outside the sandboxed identity', async () => {
        const paths = identity('read-escape');
        const token = randomBytes(16).toString('hex');
        const secret = path.join(dataDir, 'secret.key');
        fs.writeFileSync(secret, token, { mode: 0o600 });
        const proof = control(paths);
        const output = await inSandbox(paths, `${proof.read} cat ${JSON.stringify(secret)}; printf "|end"`);
        expect(output).toContain(proof.marker);
        expect(output).not.toContain(token);
    });

    it.skipIf(!detected?.available)('cannot read the manager application tree', async () => {
        // Where the manager is installed under a bound system root, the read-only
        // root bind used to carry its working tree — and the `.env` dotenv loads
        // from it — into the namespace.
        const paths = identity('app-root-escape');
        const token = randomBytes(16).toString('hex');
        const canary = path.join(process.cwd(), `.codex-test-probe-${token}`);
        fs.writeFileSync(canary, token, { mode: 0o600 });
        const proof = control(paths);
        try {
            const output = await inSandbox(paths, `${proof.read} cat ${JSON.stringify(canary)}; printf "|end"`);
            expect(output).toContain(proof.marker);
            expect(output).not.toContain(token);
        } finally { fs.rmSync(canary, { force: true }); }
    });

    it.skipIf(!detected?.available)('cannot write into the manager data directory', async () => {
        const paths = identity('write-escape');
        const target = path.join(dataDir, `escape-${randomBytes(6).toString('hex')}`);
        const proof = control(paths);
        const output = await inSandbox(paths, `${proof.read} printf x > ${JSON.stringify(target)}; printf "|end"`);
        expect(output).toContain(proof.marker);
        expect(fs.existsSync(target)).toBe(false);
    });

    it.skipIf(!detected?.available)('cannot reach another identity runtime directory', async () => {
        const mine = identity('neighbour-a');
        const theirs = identity('neighbour-b');
        const token = randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(theirs.codexHome, 'auth.json'), token, { mode: 0o600 });
        const proof = control(mine);
        const output = await inSandbox(mine, `${proof.read} cat ${JSON.stringify(path.join(theirs.codexHome, 'auth.json'))}; printf "|end"`);
        expect(output).toContain(proof.marker);
        expect(output).not.toContain(token);
    });

    it.skipIf(!detected?.available)('can still write inside its own runtime directory', async () => {
        const paths = identity('own-write');
        const marker = path.join(paths.workDir, 'marker');
        await inSandbox(paths, `printf ok > ${JSON.stringify(marker)}; printf "|end"`);
        expect(fs.readFileSync(marker, 'utf8')).toBe('ok');
    });

    it.skipIf(!detected?.available)('passes no inherited credential into the sandbox', async () => {
        process.env.OPENAI_API_KEY = 'inherited-platform-key';
        try {
            const paths = identity('env-escape');
            const output = await inSandbox(paths, 'env; printf "|end"');
            expect(output).not.toContain('inherited-platform-key');
            expect(output).toContain('|end');
        } finally { delete process.env.OPENAI_API_KEY; }
    });
});
