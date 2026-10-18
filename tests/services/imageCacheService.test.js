import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ fetchSafe: vi.fn(), cacheDir: '' }));
vi.mock('../../src/config/constants.js', () => ({
    get CACHE_DIR() { return mocks.cacheDir; },
    DEFAULT_USER_AGENT: 'Mozilla/5.0 image-cache-test-browser',
}));
vi.mock('../../src/services/logoResolver.js', () => ({ getLogoCacheHash: url => crypto.createHash('md5').update(url).digest('hex') }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe: mocks.fetchSafe }));
const imageCache = await import('../../src/services/imageCacheService.js');
const { getCachedImage, clearImageCache } = imageCache;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-cache-test-'));
const url = 'https://cdn.example/icon.png?token=secret';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const changed = Buffer.concat([png, Buffer.from('changed')]);
const response = (body = png, headers = {}, status = 200) => ({ status, ok: status === 200, headers: new Headers({ 'content-type': 'image/png', ...headers }), body: Readable.from([body]) });
beforeEach(async () => {
    mocks.cacheDir = await fs.mkdtemp(path.join(root, 'case-'));
    mocks.fetchSafe.mockReset();
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe('image disk cache', () => {
    it('adopts an already fetched image without another upstream request and retains its validators', async () => {
        const headers = { 'UsEr-AgEnT': 'provider-agent', Authorization: 'provider-secret' };
        const prefetched = response(png, { etag: '"prefetched"' });
        mocks.fetchSafe.mockResolvedValue(response(changed));
        expect(await getCachedImage(url, { headers, response: prefetched })).toMatchObject({ body: png, cacheStatus: 'MISS' });
        expect(mocks.fetchSafe).not.toHaveBeenCalled();
        mocks.fetchSafe.mockResolvedValueOnce(response('', {}, 304));
        expect(await getCachedImage(url, { headers })).toMatchObject({ body: png, cacheStatus: 'HIT' });
        const sent = new Headers(mocks.fetchSafe.mock.calls[0][1].headers);
        expect(sent.get('user-agent')).toBe('provider-agent');
        expect(sent.get('authorization')).toBe('provider-secret');
        expect(sent.get('if-none-match')).toBe('"prefetched"');
    });

    it('discards an unused adopted response when the same image is already pending', async () => {
        mocks.fetchSafe.mockResolvedValue(response());
        const unused = response(changed);
        const first = getCachedImage(url, { response: response() });
        const second = getCachedImage(url, { response: unused });
        const discardedImmediately = unused.body.destroyed;
        const results = await Promise.all([first, second]);
        expect(discardedImmediately).toBe(true);
        expect(results.map(result => result.body)).toEqual([png, png]);
        expect(mocks.fetchSafe).not.toHaveBeenCalled();
    });

    it('uses the same bounded validation and stale fallback for adopted responses', async () => {
        mocks.fetchSafe.mockImplementation(async () => response());
        await getCachedImage(url);
        mocks.fetchSafe.mockClear();
        expect(await getCachedImage(url, { response: response(Buffer.alloc(5 * 1024 * 1024 + 1)) }))
            .toMatchObject({ body: png, cacheStatus: 'STALE' });
        expect(await getCachedImage(url, { response: response('<html>not an image</html>') }))
            .toMatchObject({ body: png, cacheStatus: 'STALE' });
        expect(mocks.fetchSafe).not.toHaveBeenCalled();
    });

    it('exports browser image headers with explicit case-insensitive overrides', () => {
        expect(imageCache.imageRequestHeaders).toBeTypeOf('function');
        expect(imageCache.imageRequestHeaders()).toEqual({
            'user-agent': 'Mozilla/5.0 image-cache-test-browser',
            accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        });
        expect(imageCache.imageRequestHeaders({ 'UsEr-AgEnT': 'custom-agent', ACCEPT: 'image/png' }))
            .toEqual({ 'user-agent': 'custom-agent', accept: 'image/png' });
    });

    it('fetches from CDNs requiring the browser user agent and image Accept defaults', async () => {
        mocks.fetchSafe.mockImplementation(async (_url, { headers }) => {
            const requestHeaders = new Headers(headers);
            if (requestHeaders.get('user-agent') !== 'Mozilla/5.0 image-cache-test-browser' ||
                requestHeaders.get('accept') !== 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8') {
                return response('Forbidden', { 'content-type': 'text/html' }, 403);
            }
            return response(png, { etag: '"cdn-icon"' });
        });
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'MISS' });
        mocks.fetchSafe.mockResolvedValueOnce(response('', {}, 304));
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'HIT' });
        const revalidationHeaders = new Headers(mocks.fetchSafe.mock.calls[1][1].headers);
        expect(revalidationHeaders.get('user-agent')).toBe('Mozilla/5.0 image-cache-test-browser');
        expect(revalidationHeaders.get('accept')).toBe('image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
        expect(revalidationHeaders.get('if-none-match')).toBe('"cdn-icon"');
        const hash = crypto.createHash('md5').update(url).digest('hex');
        expect(await fs.readFile(path.join(mocks.cacheDir, 'picons', `${hash}.png`))).toEqual(png);
    });

    it.each([
        { 'User-Agent': 'provider-agent', Accept: 'image/png' },
        { 'user-agent': 'provider-agent', accept: 'image/png' },
        { 'UsEr-AgEnT': 'provider-agent', aCcEpT: 'image/png' },
    ])('preserves explicit image request headers regardless of casing: %j', async headers => {
        mocks.fetchSafe.mockImplementation(async (_url, options) => {
            const requestHeaders = new Headers(options.headers);
            if (requestHeaders.get('user-agent') !== 'provider-agent' || requestHeaders.get('accept') !== 'image/png') {
                return response('Forbidden', { 'content-type': 'text/html' }, 403);
            }
            return response();
        });
        expect(await getCachedImage(url, { headers })).toMatchObject({ body: png, cacheStatus: 'MISS' });
    });

    it('revalidates unchanged images and updates changed bytes at the same URL', async () => {
        mocks.fetchSafe.mockResolvedValueOnce(response(png, { etag: '"one"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }))
            .mockResolvedValueOnce(response('', {}, 304)).mockResolvedValueOnce(response(changed, { etag: '"two"' }));
        expect(await getCachedImage(url)).toMatchObject({ body: png, contentType: 'image/png', cacheStatus: 'MISS' });
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'HIT' });
        expect(mocks.fetchSafe.mock.calls[1][1].headers).toMatchObject({ 'If-None-Match': '"one"', 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT' });
        expect(await getCachedImage(url)).toMatchObject({ body: changed, cacheStatus: 'REVALIDATED' });
    });

    it('refreshes legacy files without trusting their existence forever', async () => {
        const dir = path.join(mocks.cacheDir, 'picons');
        await fs.mkdir(dir);
        const file = path.join(dir, `${crypto.createHash('md5').update(url).digest('hex')}.png`);
        await fs.writeFile(file, png);
        mocks.fetchSafe.mockResolvedValue(response(changed));
        expect(await getCachedImage(url)).toMatchObject({ body: changed, cacheStatus: 'REVALIDATED' });
        expect(await fs.readFile(file)).toEqual(changed);
    });

    it('coalesces concurrent requests and isolates credentials without storing them', async () => {
        mocks.fetchSafe.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return response(); });
        const results = await Promise.all(Array.from({ length: 6 }, () => getCachedImage(url, { headers: { Authorization: 'secretA' } })));
        expect(results.every(result => result.body.equals(png))).toBe(true);
        expect(mocks.fetchSafe).toHaveBeenCalledTimes(1);
        await getCachedImage(url, { headers: { authorization: 'secretB' } });
        expect(mocks.fetchSafe).toHaveBeenCalledTimes(2);
        const files = await fs.readdir(path.join(mocks.cacheDir, 'picons'));
        expect(files.filter(file => file.endsWith('.png'))).toHaveLength(2);
        for (const file of files.filter(file => file.endsWith('.json'))) {
            expect(await fs.readFile(path.join(mocks.cacheDir, 'picons', file), 'utf8')).not.toMatch(/secret|cdn\.example|Authorization/);
        }
    });

    it('preserves the last good image after upstream failures or partial bodies', async () => {
        mocks.fetchSafe.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error(url));
        await getCachedImage(url);
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'STALE' });
        const broken = new Readable({ read() { this.push('partial'); this.destroy(new Error('dropped')); } });
        mocks.fetchSafe.mockResolvedValueOnce({ ...response(), body: broken });
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'STALE' });
        const files = await fs.readdir(path.join(mocks.cacheDir, 'picons'));
        expect(files.some(file => file.includes('.tmp'))).toBe(false);
    });

    it.each([
        ['image/svg+xml', '<svg><image href="https://tracker.example"/></svg>'],
        ['image/png', '<html>provider error</html>'],
        ['application/octet-stream', '<?xml version="1.0"?><svg/>'],
        ['text/html', '<html>provider error</html>'],
    ])('rejects unsafe image content %s', async (contentType, body) => {
        mocks.fetchSafe.mockResolvedValue(response(body, { 'content-type': contentType }));
        await expect(getCachedImage(url)).rejects.toThrow('Image unavailable');
        expect(await fs.readdir(path.join(mocks.cacheDir, 'picons')).catch(() => [])).toEqual([]);
    });

    it('allows self-contained SVG drawing content and retains it when external SVG appears', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="red" d="M0 0h10v10z"/></svg>');
        mocks.fetchSafe.mockResolvedValueOnce(response(svg, { 'content-type': 'image/svg+xml' }))
            .mockResolvedValueOnce(response('<svg><use href="https://tracker.example/a.svg#x"/></svg>', { 'content-type': 'image/svg+xml' }));
        expect(await getCachedImage(url)).toMatchObject({ body: svg, contentType: 'image/svg+xml' });
        expect(await getCachedImage(url)).toMatchObject({ body: svg, cacheStatus: 'STALE' });
    });

    it('rejects oversized responses and discards rejected status bodies', async () => {
        mocks.fetchSafe.mockResolvedValueOnce(response(Buffer.alloc(5 * 1024 * 1024 + 1)));
        await expect(getCachedImage(url)).rejects.toThrow('Image unavailable');
        const rejected = response('error', {}, 500);
        mocks.fetchSafe.mockResolvedValueOnce(rejected);
        await expect(getCachedImage(url)).rejects.toThrow('Image unavailable');
        expect(rejected.body.destroyed).toBe(true);
    });

    it('bounds stalled response bodies and permits a successful retry afterward', async () => {
        vi.useFakeTimers();
        try {
            const stalled = new Readable({ read() {} });
            mocks.fetchSafe.mockResolvedValueOnce({ ...response(), body: stalled });
            const request = getCachedImage(url);
            const rejected = expect(request).rejects.toThrow('Image unavailable');
            // Let the disk read finish and the real body reader install its deadline.
            await vi.waitFor(() => expect(mocks.fetchSafe).toHaveBeenCalledTimes(1));
            await vi.advanceTimersByTimeAsync(30001);
            await rejected;
            expect(stalled.destroyed).toBe(true);
        } finally { vi.useRealTimers(); }
        mocks.fetchSafe.mockResolvedValueOnce(response());
        expect(await getCachedImage(url)).toMatchObject({ body: png, cacheStatus: 'MISS' });
    });

    it('never attaches validators from metadata belonging to different bytes', async () => {
        mocks.fetchSafe.mockResolvedValueOnce(response(png, { etag: '"one"' })).mockResolvedValueOnce(response(changed));
        await getCachedImage(url);
        const file = path.join(mocks.cacheDir, 'picons', `${crypto.createHash('md5').update(url).digest('hex')}.png`);
        await fs.writeFile(file, changed);
        expect(await getCachedImage(url)).toMatchObject({ body: changed });
        expect(mocks.fetchSafe.mock.calls[1][1].headers['If-None-Match']).toBeUndefined();
    });

    it('clears picons only, including metadata', async () => {
        mocks.fetchSafe.mockResolvedValue(response());
        await getCachedImage(url);
        await fs.writeFile(path.join(mocks.cacheDir, 'unrelated'), 'keep');
        expect(await clearImageCache()).toBe(2);
        expect(await fs.readFile(path.join(mocks.cacheDir, 'unrelated'), 'utf8')).toBe('keep');
        expect(await clearImageCache()).toBe(0);
    });
});
