#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

// Original ffmpeg-static 5.3.0 / b6.1.1 release assets, including its notices.
const licenseSha = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
const asset = (id, bytes, sha256) => ({ id, bytes, sha256 });
const assets = {
    x64: { elfClass: 2, machine: 62,
        binary: asset(316528626, 29354986, 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa'),
        readme: asset(316529927, 2235, '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537'),
        license: asset(316529924, 35147, licenseSha) },
    ia32: { elfClass: 1, machine: 3,
        binary: asset(316528517, 22184031, '169b27c078a8ecedb814cac67afccf15a9868d63e9d74ef86088adefaa500d00'),
        readme: asset(316529918, 2209, '3bbce64eba997007b3fd5324bb105f10ab6b0a499796c7d34b844b51fda0528b'),
        license: asset(316529913, 35147, licenseSha) },
    arm64: { elfClass: 2, machine: 183,
        binary: asset(316528458, 25568691, '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0'),
        readme: asset(316529906, 2217, 'd6777d2fd276b23f0ac6666fa619e88ffe4826521881c7ff83836e30cb4acec2'),
        license: asset(316529900, 35147, licenseSha) },
    arm: { elfClass: 1, machine: 40,
        binary: asset(316528390, 19167563, '64b115a12f0ab77c277e3c418aae8b40ef881e75e746a0e2d066a206b9bc5172'),
        readme: asset(316529893, 2178, 'faaea83a6d92419cb112d5de5ac673f51b72401830e068c4d003b3229ee1c89a'),
        license: asset(316529888, 35147, licenseSha) },
};

export function selectAssets(platform, arch) {
    if (platform !== 'linux' || !Object.hasOwn(assets, arch)) throw new Error(`Unsupported FFmpeg target: ${platform}/${arch}`);
    return assets[arch];
}

export async function downloadAsset(pin, destination, request = fetch) {
    let url = `https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/${pin.id}`;
    for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000),
            headers: { Accept: 'application/octet-stream', 'User-Agent': 'IPTV-Manager-FFmpeg-preparer' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const next = new URL(response.headers.get('location'), url);
            if (next.protocol !== 'https:' || next.username || next.password || next.hash || (next.port && next.port !== '443') ||
                !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) {
                throw new Error('Unsafe FFmpeg redirect');
            }
            url = next.href;
            continue;
        }
        if (response.status !== 200) {
            await response.body?.cancel();
            const host = new URL(url).hostname;
            const headers = host === 'api.github.com' ? ['x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-limit', 'retry-after'].flatMap(name => {
                const value = response.headers.get(name);
                return /^\d{1,10}$/.test(value ?? '') ? [`${name}=${value}`] : [];
            }) : [];
            throw new Error(`FFmpeg asset download failed (HTTP ${response.status}; host=${host}${headers.length ? '; ' + headers.join('; ') : ''})`);
        }
        const hash = createHash('sha256');
        let bytes = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
            bytes += chunk.length;
            if (bytes > pin.bytes) return callback(new Error('FFmpeg asset size exceeds pin'));
            hash.update(chunk);
            callback(null, chunk);
        } }), createWriteStream(destination, { flags: 'wx' }));
        if (bytes !== pin.bytes) throw new Error('FFmpeg asset size differs from pin');
        if (hash.digest('hex') !== pin.sha256) throw new Error('FFmpeg asset SHA-256 mismatch');
        return;
    }
    throw new Error('Too many FFmpeg redirects');
}

export async function installFfmpeg(binary, selected, request = fetch) {
    if (!binary || !path.isAbsolute(binary)) throw new Error('FFMPEG_BIN must be an absolute persistent file path');
    await mkdir(path.dirname(binary), { recursive: true });
    const stage = await mkdtemp(path.join(path.dirname(binary), '.ffmpeg-'));
    try {
        for (const file of ['binary', 'readme', 'license']) await downloadAsset(selected[file], path.join(stage, file), request);
        const hash = createHash('sha256');
        let bytes = 0;
        const executable = path.join(stage, 'ffmpeg');
        await pipeline(createReadStream(path.join(stage, 'binary')), createGunzip(), new Transform({ transform(chunk, encoding, callback) {
            bytes += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
        } }), createWriteStream(executable, { flags: 'wx' }));
        const file = await open(executable);
        const header = Buffer.alloc(20);
        try {
            const read = await file.read(header, 0, header.length, 0);
            if (read.bytesRead !== header.length || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
                header[4] !== selected.elfClass || header[5] !== 1 || header.readUInt16LE(18) !== selected.machine) {
                throw new Error('FFmpeg ELF architecture differs from target');
            }
        } finally { await file.close(); }
        await chmod(executable, 0o755);
        // Publish the executable last so failed downloads never replace a working binary.
        await rename(path.join(stage, 'readme'), binary + '.README');
        await rename(path.join(stage, 'license'), binary + '.LICENSE');
        await rename(executable, binary);
        return { binary, bytes, sha256: hash.digest('hex') };
    } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function prepareFfmpeg(binary, { platform = process.platform, arch = process.arch, request = fetch } = {}) {
    return installFfmpeg(binary, selectAssets(platform, arch), request);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try { console.log(JSON.stringify(await prepareFfmpeg(process.env.FFMPEG_BIN))); }
    catch (error) { console.error(`FFmpeg preparation failed: ${error.message}`); process.exitCode = 1; }
}
