import { beforeEach, afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), cacheDir: '' }));
vi.mock('node-fetch', async original => ({ ...(await original()), default: mocks.fetch }));
vi.mock('../../src/utils/helpers.js', async original => ({ ...(await original()), isSafeUrl: async () => true }));
vi.mock('../../src/config/constants.js', async original => ({ ...(await original()), get CACHE_DIR() { return mocks.cacheDir; } }));
vi.mock('../../src/services/logoResolver.js', () => ({ getLogoCacheHash: url => crypto.createHash('md5').update(url).digest('hex') }));
const { getCachedImage } = await import('../../src/services/imageCacheService.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-redirect-cache-'));
beforeEach(async () => { mocks.fetch.mockReset(); mocks.cacheDir = await fs.mkdtemp(path.join(root, 'case-')); });
afterAll(() => fs.rm(root, { recursive: true, force: true }));

it('replaces cached alias images when redirected resources use colliding local validators', async () => {
  const alias = 'https://cdn.example/icon';
  const targetA = 'https://cdn.example/a.png';
  const targetB = 'https://cdn.example/b.png';
  const firstBytes = Buffer.from('first-raster-image');
  const nextBytes = Buffer.from('updated-raster-image');
  let target = targetA;
  const response = (url, status, headers, body = '') => ({ url, status, ok: status === 200, headers: new Headers(headers), body: Readable.from([body]) });
  mocks.fetch.mockImplementation(async (url, options) => {
    if (url === alias) return response(url, 302, { location: target });
    const validators = new Headers(options.headers);
    const headers = { etag: '"1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT', 'content-type': 'image/png' };
    if (validators.get('if-none-match') === '"1"' || validators.has('if-modified-since')) return response(url, 304, headers);
    return response(url, 200, headers, url === targetA ? firstBytes : nextBytes);
  });
  expect(await getCachedImage(alias)).toMatchObject({ body: firstBytes, cacheStatus: 'MISS' });
  target = targetB;
  expect(await getCachedImage(alias)).toMatchObject({ body: nextBytes, cacheStatus: 'REVALIDATED' });
  const aliasHeaders = new Headers(mocks.fetch.mock.calls[2][1].headers);
  expect(aliasHeaders.get('if-none-match')).toBe('"1"');
  const finalHeaders = new Headers(mocks.fetch.mock.calls[3][1].headers);
  expect(finalHeaders.has('if-none-match')).toBe(false);
  expect(finalHeaders.has('if-modified-since')).toBe(false);
  for (const [, options] of mocks.fetch.mock.calls) expect(options).not.toHaveProperty('stripConditionalOnRedirect');
});
