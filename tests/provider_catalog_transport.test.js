import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../src/utils/network.js', async original => ({ ...(await original()), fetchSafe }));
const priorTimeout = process.env.CATALOG_BODY_TIMEOUT_MS;
const priorMax = process.env.CATALOG_BODY_MAX_BYTES;
process.env.CATALOG_BODY_TIMEOUT_MS = '1000';
process.env.CATALOG_BODY_MAX_BYTES = '1048576';
const { fetchProviderCatalog } = await import('../src/services/providerCatalogSyncService.js');
afterAll(() => {
  if (priorTimeout === undefined) delete process.env.CATALOG_BODY_TIMEOUT_MS;
  else process.env.CATALOG_BODY_TIMEOUT_MS = priorTimeout;
  if (priorMax === undefined) delete process.env.CATALOG_BODY_MAX_BYTES;
  else process.env.CATALOG_BODY_MAX_BYTES = priorMax;
});
const provider = { id: 1, url: 'https://panel.example', username: 'u', password: 'p' };
const jsonResponse = value => ({ ok: true, status: 200,
  headers: { get: () => 'application/json' }, body: Readable.from([JSON.stringify(value)]) });
const xtream = { getChannels: vi.fn(async () => [{ stream_id: 99, name: 'Unsafe client result' }]) };
beforeEach(() => { fetchSafe.mockReset(); xtream.getChannels.mockClear(); });

it('downloads live streams through the bounded safe transport', async () => {
  fetchSafe.mockImplementation(async url => jsonResponse(String(url).includes('action=get_live_streams')
    ? [{ stream_id: 10, name: 'Safe result' }] : []));
  const result = await fetchProviderCatalog(provider, xtream);
  expect(result.allChannels).toEqual([expect.objectContaining({ stream_id: 10, name: 'Safe result' })]);
  expect(result.completeStreamTypes.has('live')).toBe(true);
  expect(xtream.getChannels).not.toHaveBeenCalled();
});

it('times out a live response whose body stalls after its headers', async () => {
  const body = new Readable({ read() {} });
  body.push('[');
  fetchSafe.mockImplementation(async url => String(url).includes('action=get_live_streams')
    ? { ...jsonResponse([]), body } : { ok: false, status: 502, body: Readable.from([]) });
  const started = Date.now();
  const result = await fetchProviderCatalog(provider, xtream);
  expect(result.completeStreamTypes.has('live')).toBe(false);
  expect(result.failures).toContainEqual(expect.objectContaining({ section: 'live', message: expect.stringMatching(/exceeded|timeout|aborted/i) }));
  expect(body.destroyed).toBe(true);
  expect(Date.now() - started).toBeLessThan(4000);
});

it('refuses a live catalog over the configured body limit', async () => {
  const response = jsonResponse([{ stream_id: 10, name: 'x'.repeat(1048576) }]);
  fetchSafe.mockImplementation(async url => String(url).includes('action=get_live_streams')
    ? response : { ok: false, status: 502, body: Readable.from([]) });
  const result = await fetchProviderCatalog(provider, xtream);
  expect(result.completeStreamTypes.has('live')).toBe(false);
  expect(result.failures).toContainEqual(expect.objectContaining({ section: 'live', message: expect.stringMatching(/exceeds|limit/i) }));
  expect(response.body.destroyed).toBe(true);
});

it('replaces an invalid live payload with the complete M3U fallback', async () => {
  fetchSafe.mockImplementation(async url => String(url) === provider.url
    ? { ok: true, body: Readable.from(['#EXTM3U\n#EXTINF:-1,Recovered channel\nhttps://cdn.test/live.ts\n']) }
    : jsonResponse(String(url).includes('action=get_live_streams') ? {} : []));
  const result = await fetchProviderCatalog(provider);
  expect(result.allChannels).toEqual([expect.objectContaining({ name: 'Recovered channel', original_url: 'https://cdn.test/live.ts' })]);
  expect(result.completeStreamTypes.has('live')).toBe(true);
  expect(result.failures).toEqual([]);
});

it('bounds the M3U fallback body before the parser can buffer an oversized line', async () => {
  const body = Readable.from(['#EXTM3U\n#EXTINF:-1,', 'x'.repeat(1048576), '\nhttps://cdn.test/live.ts\n']);
  fetchSafe.mockImplementation(async url => String(url) === provider.url
    ? { ok: true, body } : jsonResponse(String(url).includes('action=get_live_streams') ? {} : []));
  const result = await fetchProviderCatalog(provider);
  expect(result.completeStreamTypes.has('live')).toBe(false);
  expect(result.allChannels).toEqual([]);
  expect(result.failures).toContainEqual(expect.objectContaining({ section: 'live', message: expect.stringMatching(/exceeds|limit/i) }));
  expect(body.destroyed).toBe(true);
});
