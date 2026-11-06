import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

vi.mock('../src/database/db.js', () => ({ default: {} }));
vi.mock('../src/services/streamManager.js', () => ({ default: {} }));
vi.mock('../src/services/clientResourceService.js', () => ({ createClientResourceUrl: vi.fn() }));
// Allow the local fixture without changing the real fetch or its timeout handling.
vi.mock('../src/utils/helpers.js', async original => ({
  ...(await original()),
  isSafeUrl: async () => true,
  safeLookup: (hostname, options, callback) => dns.lookup(hostname, options, callback),
}));

const { buildBackupUrls, fetchWithBackups } = await import('../src/controllers/streamControllerHelpers.js');
let server, base;
const requests = [];
const sockets = new Set();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/stalled') return;
    if (req.url === '/empty') {
      res.writeHead(200, { 'content-length': '0' }).end();
      return;
    }
    if (req.url === '/empty-chunked') {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.flushHeaders();
      res.end();
      return;
    }
    if (req.url === '/stalled-body') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.flushHeaders();
      return;
    }
    if (req.url === '/broken-body') {
      res.writeHead(200, { 'content-length': '16' });
      res.flushHeaders();
      setImmediate(() => res.destroy());
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      res.write(Buffer.from([0x47]));
      const timer = setTimeout(() => res.end(Buffer.from([0, 0xff, 0x80, 0])), 250);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/blocked') {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' }).end('working-stream');
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { requests.length = 0; });
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

describe('provider backup failures', () => {
  it('uses a working backup when the primary never sends headers', async () => {
    const result = await fetchWithBackups(`${base}/stalled`, [`${base}/backup`], {
      timeout: 100, signal: new AbortController().signal,
    });
    expect(await result.response.text()).toBe('working-stream');
    expect(result.selectedUrl).toBe(`${base}/backup`);
    expect(requests).toEqual(['/stalled', '/backup']);
  });

  it('continues past a stalled backup to a later entry in the configured list', async () => {
    const backups = buildBackupUrls(JSON.stringify([`${base}/stalled`, `${base}/backup`]), url => url, 'test');
    const result = await fetchWithBackups(`${base}/blocked`, backups, { timeout: 100 });
    expect(await result.response.text()).toBe('working-stream');
    expect(result.selectedUrl).toBe(`${base}/backup`);
    expect(requests).toEqual(['/blocked', '/stalled', '/backup']);
  });

  it('does not try a backup when the caller cancels the request', async () => {
    const controller = new AbortController();
    const onRequest = req => {
      if (req.url === '/stalled') controller.abort();
    };
    server.on('request', onRequest);
    try {
      await expect(fetchWithBackups(`${base}/stalled`, [`${base}/backup`], {
        timeout: 1000, signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(requests).toEqual(['/stalled']);
    } finally {
      server.off('request', onRequest);
    }
  });

  it('rejects after every configured address times out', async () => {
    await expect(fetchWithBackups(`${base}/stalled`, [`${base}/stalled`], { timeout: 100 }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual(['/stalled', '/stalled']);
  });

  it.each(['/empty', '/empty-chunked', '/stalled-body', '/broken-body'])(
    'tries a backup when HTTP 200 at %s delivers no data', async path => {
      const result = await fetchWithBackups(`${base}${path}`, [`${base}/backup`], { timeout: 100 });
      expect(await result.response.text()).toBe('working-stream');
      expect(result.selectedUrl).toBe(`${base}/backup`);
      expect(requests).toEqual([path, '/backup']);
    },
  );

  it('continues past an empty backup to a later entry', async () => {
    const result = await fetchWithBackups(`${base}/blocked`, [`${base}/empty`, `${base}/backup`], { timeout: 100 });
    expect(await result.response.text()).toBe('working-stream');
    expect(requests).toEqual(['/blocked', '/empty', '/backup']);
  });

  it('rejects when all HTTP 200 responses are empty', async () => {
    await expect(fetchWithBackups(`${base}/empty`, [`${base}/empty-chunked`], { timeout: 100 }))
      .rejects.toThrow(/empty/i);
    expect(requests).toEqual(['/empty', '/empty-chunked']);
  });

  it('preserves every byte and leaves a healthy stream running beyond the initial-data timeout', async () => {
    const result = await fetchWithBackups(`${base}/stream`, [`${base}/backup`], { timeout: 100 });
    const chunks = [];
    await pipeline(result.response.body, new Writable({
      write(chunk, encoding, callback) { chunks.push(chunk); callback(); },
    }));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x47, 0, 0xff, 0x80, 0]));
    expect(requests).toEqual(['/stream']);
  });

  it('does not try a backup when cancelled while waiting for the first body bytes', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await expect(fetchWithBackups(`${base}/stalled-body`, [`${base}/backup`], {
        timeout: 1000, signal: controller.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(requests).toEqual(['/stalled-body']);
    } finally {
      clearTimeout(timer);
    }
  });

  it('accepts an empty HEAD response without using a backup', async () => {
    const result = await fetchWithBackups(`${base}/empty`, [`${base}/backup`], { method: 'HEAD', timeout: 100 });
    expect(await result.response.text()).toBe('');
    expect(requests).toEqual(['/empty']);
  });

  it.each(['aborted', 'close'])('stops probing and releases client listeners on %s', async event => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    const timer = setTimeout(() => {
      if (event === 'aborted') { req.aborted = true; req.emit(event); }
      else { res.destroyed = true; res.emit(event); }
    }, 50);
    try {
      await expect(fetchWithBackups(`${base}/stalled-body`, [`${base}/backup`], { timeout: 1000 }, { req, res }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(requests).toEqual(['/stalled-body']);
      expect(req.listenerCount('aborted')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });
});
