import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { downloadAsset, installFfmpeg, selectAssets } from '../scripts/prepare-ffmpeg.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const elf = Buffer.alloc(64);
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
elf.writeUInt16LE(62, 18);
const bodies = { 1: gzipSync(elf), 2: Buffer.from('Original upstream README\n'), 3: Buffer.from('Original upstream LICENSE\n') };
const fixture = { elfClass: 2, machine: 62, ...Object.fromEntries(['binary', 'readme', 'license'].map((key, index) => {
    const id = index + 1;
    return [key, { id, bytes: bodies[id].length, sha256: digest(bodies[id]) }];
})) };
const request = async url => new Response(bodies[Number(new URL(url).pathname.split('/').at(-1))]);
let directory;
let binary;

beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'manager-ffmpeg-test-'));
    binary = path.join(directory, 'ffmpeg');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe('pinned FFmpeg preparation', () => {
    it('preserves all upstream Linux architectures with exact release asset identities', () => {
        for (const [arch, id, machine, elfClass] of [['x64', 316528626, 62, 2], ['ia32', 316528517, 3, 1], ['arm64', 316528458, 183, 2], ['arm', 316528390, 40, 1]]) {
            const selected = selectAssets('linux', arch);
            expect(selected.binary.id).toBe(id);
            expect([selected.machine, selected.elfClass]).toEqual([machine, elfClass]);
            for (const file of ['binary', 'readme', 'license']) {
                expect(selected[file].sha256).toMatch(/^[0-9a-f]{64}$/);
                expect(selected[file].bytes).toBeGreaterThan(0);
            }
        }
        expect(() => selectAssets('linux', 's390x')).toThrow(/Unsupported/);
        expect(() => selectAssets('darwin', 'arm64')).toThrow(/Unsupported/);
    });

    it('publishes the exact executable, README and license only after all checks pass', async () => {
        const result = await installFfmpeg(binary, fixture, request);
        expect(await readFile(binary)).toEqual(elf);
        expect(await readFile(binary + '.README')).toEqual(bodies[2]);
        expect(await readFile(binary + '.LICENSE')).toEqual(bodies[3]);
        expect((await stat(binary)).mode & 0o777).toBe(0o755);
        expect(result).toEqual({ binary, bytes: elf.length, sha256: digest(elf) });
        expect((await readdir(directory)).sort()).toEqual(['ffmpeg', 'ffmpeg.LICENSE', 'ffmpeg.README']);
    });

    it('makes the real ffmpeg-static installer skip all downloads and export the same runtime path', async () => {
        await installFfmpeg(binary, fixture, request);
        const env = { ...process.env, FFMPEG_BIN: binary, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' };
        const install = spawnSync(process.execPath, ['node_modules/ffmpeg-static/install.js'], { env, encoding: 'utf8', timeout: 5000 });
        expect(install.status, install.stderr).toBe(0);
        expect(install.stdout).toContain('is installed already');
        const runtime = spawnSync(process.execPath, ['-e', 'console.log(require("ffmpeg-static"))'], { env, encoding: 'utf8' });
        expect(runtime.status).toBe(0);
        expect(runtime.stdout.trim()).toBe(binary);
        const pkg = JSON.parse(await readFile('node_modules/ffmpeg-static/package.json', 'utf8'));
        expect(pkg.version).toBe('5.3.0');
        expect(pkg['ffmpeg-static']['binary-release-tag']).toBe('b6.1.1');
    });

    it.each(['binary', 'readme', 'license'])('rejects a wrong %s checksum without replacing a working installation', async key => {
        await writeFile(binary, 'previous working executable');
        const bad = { ...fixture, [key]: { ...fixture[key], sha256: '0'.repeat(64) } };
        await expect(installFfmpeg(binary, bad, request)).rejects.toThrow(/SHA-256/);
        expect(await readFile(binary, 'utf8')).toBe('previous working executable');
        expect(await readdir(directory)).toEqual(['ffmpeg']);
    });

    it('cleans a partial streamed download and preserves the old binary', async () => {
        await writeFile(binary, 'old binary');
        const interrupted = async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(bodies[1].subarray(0, 10));
            controller.error(new Error('connection dropped'));
        } }));
        await expect(installFfmpeg(binary, fixture, interrupted)).rejects.toThrow(/connection dropped/);
        expect(await readFile(binary, 'utf8')).toBe('old binary');
        expect(await readdir(directory)).toEqual(['ffmpeg']);
    });

    it('rejects a truncated response even when its supplied hash matches those short bytes', async () => {
        const short = bodies[1].subarray(0, 10);
        const assets = { ...fixture, binary: { ...fixture.binary, sha256: digest(short) } };
        await expect(installFfmpeg(binary, assets, async () => new Response(short))).rejects.toThrow(/size/);
        expect(await readdir(directory)).toEqual([]);
    });

    it('rejects a pinned archive containing the wrong ELF architecture', async () => {
        await expect(installFfmpeg(binary, { ...fixture, machine: 183 }, request)).rejects.toThrow(/ELF/);
        expect(await readdir(directory)).toEqual([]);
    });

    it('rejects HTTP failures without publishing partial files', async () => {
        await expect(installFfmpeg(binary, fixture, async () => new Response(null, { status: 504 }))).rejects.toThrow(/HTTP 504/);
        expect(await readdir(directory)).toEqual([]);
    });
});

describe('official GitHub release API downloads', () => {
    it('follows only the official HTTPS release CDN and requests anonymous octet streams', async () => {
        const calls = [];
        await downloadAsset(fixture.binary, binary, async (url, options) => {
            calls.push({ url, options });
            return calls.length === 1
                ? new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/signed-asset?token=public-signature' } })
                : new Response(bodies[1]);
        });
        expect(calls.map(c => new URL(c.url).hostname)).toEqual(['api.github.com', 'release-assets.githubusercontent.com']);
        expect(calls[0].url).toBe('https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/1');
        expect(calls.every(c => c.options.redirect === 'manual' && !c.options.headers.Authorization)).toBe(true);
        expect(calls[0].options.headers.Accept).toBe('application/octet-stream');
        expect(await readFile(binary)).toEqual(bodies[1]);
    });

    it.each(['https://example.com/asset', 'http://release-assets.githubusercontent.com/asset', 'https://user:password@release-assets.githubusercontent.com/asset', 'https://release-assets.githubusercontent.com:444/asset'])('rejects redirect %s before sending another request', async location => {
        let calls = 0;
        await expect(downloadAsset(fixture.binary, binary, async () => {
            calls++;
            return new Response(null, { status: 302, headers: { Location: location } });
        })).rejects.toThrow(/redirect/);
        expect(calls).toBe(1);
    });

    it('bounds redirect loops', async () => {
        let calls = 0;
        await expect(downloadAsset(fixture.binary, binary, async () => {
            calls++;
            return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/loop' } });
        })).rejects.toThrow(/redirect/);
        expect(calls).toBeLessThanOrEqual(4);
    });
});
