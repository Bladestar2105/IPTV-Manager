import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb }));
vi.mock('../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  isSafeUrl: async () => true, // The real HTTP fixture uses loopback.
}));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: value => value }));
vi.mock('../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));

const { syncSeriesEpisode, syncSeriesEpisodes } = await import('../src/services/seriesSyncService.js');
const { clearProviderLocks } = await import('../src/services/providerLockService.js');

memDb.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT);
  CREATE TABLE provider_channels (provider_id INTEGER, remote_stream_id INTEGER, stream_type TEXT, metadata TEXT);
  CREATE TABLE provider_series_episodes (
    source_key TEXT, series_remote_id INTEGER, remote_episode_id INTEGER,
    season INTEGER, episode_num INTEGER, title TEXT, container_extension TEXT, logo TEXT, added TEXT,
    PRIMARY KEY (source_key, series_remote_id, remote_episode_id)
  );
  CREATE TABLE provider_series_state (
    source_key TEXT, series_remote_id INTEGER, last_modified TEXT, synced_at INTEGER,
    PRIMARY KEY (source_key, series_remote_id)
  );
  INSERT INTO provider_channels VALUES (1, 555, 'series', '{}');
`);

let server;
const sockets = new Set();
let requests;

beforeEach(async () => {
  clearProviderLocks();
  requests = [];
  server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.write('Unauthorized'); // Keep the error body open until the client closes it.
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  memDb.prepare("INSERT OR REPLACE INTO providers VALUES (1, 'panel', ?, 'u', 'p')")
    .run(`http://127.0.0.1:${server.address().port}`);
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  vi.restoreAllMocks();
});

afterAll(() => memDb.close());

describe('series episode HTTP error cleanup', () => {
  it.each(['on-demand', 'batch'])('closes an unfinished error response after %s fetch', async mode => {
    // Observe the real request and real timers; fetchSafe/node-fetch are not replaced.
    const requestSpy = vi.spyOn(http, 'request');
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const result = mode === 'on-demand' ? await syncSeriesEpisode(1, 555) : await syncSeriesEpisodes(1);

    expect(result).toMatchObject({ synced: 0, failed: 1 });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0], 'http://panel').searchParams.get('series_id')).toBe('555');
    const request = requestSpy.mock.results[0].value;
    const headerTimers = timerSpy.mock.calls.flatMap(([, delay], index) => delay === 30000 ? [timerSpy.mock.results[index].value] : []);
    expect(headerTimers).toHaveLength(1);
    for (const timer of headerTimers) expect(clearSpy).toHaveBeenCalledWith(timer);

    await vi.waitFor(() => {
      expect(sockets.size).toBe(0);
      expect(request.destroyed).toBe(true);
      expect(request.res.destroyed).toBe(true);
      expect(request.socket.destroyed).toBe(true);
    }, { timeout: 2000, interval: 10 });
  });
});
