import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR, DEFAULT_USER_AGENT } from '../config/constants.js';
import { getLogoCacheHash } from './logoResolver.js';
import { discardBody, fetchSafe, readBodyWithLimit } from '../utils/network.js';

const MAX_BYTES = 5 * 1024 * 1024;
const pending = new Map();
const digest = body => crypto.createHash('sha256').update(body).digest('hex');
const svgTags = new Set('svg g path rect circle ellipse line polyline polygon title desc defs linearGradient radialGradient stop clipPath mask use'.split(' '));
const svgAttributes = new Set('xmlns xmlns:xlink viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-opacity stroke-dasharray stroke-dashoffset opacity transform id class version preserveAspectRatio gradientUnits gradientTransform offset stop-color stop-opacity clip-path clip-rule mask href xlink:href'.split(' '));

// Keep SVG to a static drawing subset; references must remain within this document.
function isSafeSvg(text) {
    if (!/^\s*<svg[\s>]/.test(text) || /[&]|<!|<\?|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return false;
    let end = 0;
    const stack = [];
    for (const match of text.matchAll(/<([^<>]*)>/g)) {
        if (text.slice(end, match.index).includes('<')) return false;
        end = match.index + match[0].length;
        const closing = /^\//.test(match[1]);
        const tag = /^\/?([A-Za-z][\w:-]*)/.exec(match[1]);
        if (!tag || !svgTags.has(tag[1])) return false;
        let attributes = match[1].slice(tag[0].length);
        if (closing) {
            if (attributes.trim() || stack.pop() !== tag[1]) return false;
            continue;
        }
        const selfClosing = /\/\s*$/.test(attributes);
        attributes = attributes.replace(/\/\s*$/, '');
        while (attributes.trim()) {
            const attribute = /^\s+([\w:-]+)\s*=\s*(["'])(.*?)\2/s.exec(attributes);
            if (!attribute || !svgAttributes.has(attribute[1])) return false;
            const [, name, , value] = attribute;
            if (/[<>\\]/.test(value)) return false;
            if (name === 'href' || name === 'xlink:href') {
                if (!/^#[\w.-]+$/.test(value)) return false;
            } else if (name === 'xmlns' || name === 'xmlns:xlink') {
                if (value !== (name === 'xmlns' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xlink')) return false;
            } else if (/url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) return false;
            attributes = attributes.slice(attribute[0].length);
        }
        if (!selfClosing) stack.push(tag[1]);
    }
    return end > 0 && !stack.length && !text.slice(end).trim();
}

function imageType(body, contentType) {
    if (!body.length || body.length > MAX_BYTES) throw new Error('Invalid image');
    const type = String(contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const text = body.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (type === 'image/svg+xml' || text.startsWith('<')) {
        if (!isSafeSvg(text)) throw new Error('Invalid image');
        return 'image/svg+xml';
    }
    if (!/^image\/[a-z0-9.+-]+$/.test(type) && type !== 'application/octet-stream') throw new Error('Invalid image');
    return type;
}

async function readCached(file, metadataFile) {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        const body = await fs.readFile(file);
        let metadata;
        try { metadata = JSON.parse(await fs.readFile(metadataFile, 'utf8')); } catch { /* Legacy entries have no validators. */ }
        if (metadata?.bodyHash !== digest(body)) metadata = null;
        const contentType = imageType(body, metadata?.contentType);
        return { body, contentType, metadata };
    } catch { return null; }
}

async function atomicWrite(file, body) {
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
    }
}

async function refreshImage(url, headers, key) {
    const directory = path.join(CACHE_DIR, 'picons');
    const file = path.join(directory, `${key}.png`);
    const metadataFile = path.join(directory, `${key}.json`);
    const cached = await readCached(file, metadataFile);
    try {
        const conditional = {
            'user-agent': DEFAULT_USER_AGENT,
            accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            ...headers,
        };
        for (const [field, header] of [['etag', 'If-None-Match'], ['lastModified', 'If-Modified-Since']]) {
            const value = cached?.metadata?.[field];
            if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) conditional[header] = value;
        }
        const response = await fetchSafe(url, { headers: conditional, timeout: 30000 });
        if (response.status === 304) {
            discardBody(response);
            if (!cached) throw new Error('Invalid revalidation');
            return { body: cached.body, contentType: cached.contentType, cacheStatus: 'HIT' };
        }
        if (response.status !== 200) {
            discardBody(response);
            throw new Error('Upstream image failed');
        }
        const declaredType = response.headers.get('content-type') || 'application/octet-stream';
        if (!/^image\//i.test(declaredType) && !/^application\/octet-stream(?:;|$)/i.test(declaredType)) {
            discardBody(response);
            throw new Error('Invalid image');
        }
        const body = await readBodyWithLimit(response, { as: 'buffer', maxBytes: MAX_BYTES, timeoutMs: 30000 });
        const contentType = imageType(body, declaredType);
        const metadata = { bodyHash: digest(body), contentType, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
        await fs.mkdir(directory, { recursive: true });
        await atomicWrite(file, body);
        await atomicWrite(metadataFile, JSON.stringify(metadata));
        return { body, contentType, cacheStatus: cached ? 'REVALIDATED' : 'MISS' };
    } catch {
        if (cached) return { body: cached.body, contentType: cached.contentType, cacheStatus: 'STALE' };
        throw new Error('Image unavailable');
    }
}

export async function getCachedImage(url, { headers = {} } = {}) {
    const normalizedHeaders = Object.fromEntries([...new Headers(headers).entries()].sort(([a], [b]) => a.localeCompare(b)));
    const key = Object.keys(normalizedHeaders).length ? digest(JSON.stringify([url, normalizedHeaders])) : getLogoCacheHash(url);
    if (!pending.has(key)) {
        const request = refreshImage(url, normalizedHeaders, key).finally(() => pending.delete(key));
        pending.set(key, request);
    }
    return pending.get(key);
}

export async function clearImageCache() {
    const directory = path.join(CACHE_DIR, 'picons');
    let files;
    try { files = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw new Error('Image cache could not be cleared');
    }
    let deleted = 0;
    for (const file of files) {
        if (!file.isFile() && !file.isSymbolicLink()) continue;
        try { await fs.unlink(path.join(directory, file.name)); deleted++; } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('Image cache could not be cleared');
        }
    }
    return deleted;
}
