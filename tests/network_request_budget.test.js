import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';

// The SSRF guard blocks loopback addresses. Allow the local fixture server
// through, but keep the real DNS lookup so the agent still behaves normally.
vi.mock('../src/utils/helpers.js', () => ({
  isSafeUrl: async () => true,
  safeLookup: (hostname, options, callback) => dns.lookup(hostname, options, callback),
}));

const { fetchSafe, resolveMaxRequestDurationMs } = await import('../src/utils/network.js');

let server;
let base;
const openSockets = new Set();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/stalled-body') {
      // Headers immediately, then the body never completes.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('[');
      return; // deliberately never ends
    }
    if (url.pathname === '/slow-headers') {
      const timer = setTimeout(() => res.writeHead(200).end('{}'), 5000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/huge') {
      res.writeHead(200, { 'content-length': '10485760', 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(0));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  server.on('connection', socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});

describe('resolveMaxRequestDurationMs', () => {
  it('defaults to ten minutes and accepts an override', () => {
    expect(resolveMaxRequestDurationMs(undefined)).toBe(600000);
    expect(resolveMaxRequestDurationMs('0')).toBe(600000);
    expect(resolveMaxRequestDurationMs('90000')).toBe(90000);
  });
});

describe('fetchSafe request budget', () => {
  it('completes a normal request', async () => {
    const response = await fetchSafe(`${base}/ok`, { timeout: 5000 });
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('aborts a body that never finishes', async () => {
    // Regression: the only timer was cleared as soon as the headers arrived, so
    // reading a stalled body hung forever.
    const started = Date.now();
    const response = await fetchSafe(`${base}/stalled-body`, { timeout: 5000, maxDurationMs: 600 });
    expect(response.ok).toBe(true);
    await expect(response.text()).rejects.toThrow();
    // And it aborts on the *total* budget, not on the larger header timeout.
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('treats maxDurationMs as a hard cap even below the header timeout', async () => {
    const started = Date.now();
    await expect(fetchSafe(`${base}/slow-headers`, { timeout: 30000, maxDurationMs: 400 }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('still aborts when the headers never arrive', async () => {
    const started = Date.now();
    await expect(fetchSafe(`${base}/slow-headers`, { timeout: 300 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('leaves a proxied media body running past the global deadline', async () => {
    // fetchWithBackups pipes the body straight to a player. Arming the total
    // budget there cut a healthy live session at HTTP_MAX_REQUEST_MS.
    const response = await fetchSafe(`${base}/stalled-body`, {
      timeout: 5000, maxDurationMs: 300, unboundedBody: true,
    });
    expect(response.ok).toBe(true);

    const chunks = [];
    response.body.on('data', chunk => chunks.push(chunk));
    const errored = new Promise(resolve => response.body.once('error', resolve));
    const survived = await Promise.race([
      errored.then(() => 'aborted'),
      new Promise(resolve => setTimeout(() => resolve('still streaming'), 1200)),
    ]);
    response.body.destroy();
    expect(survived).toBe('still streaming');
  }, 15000);

  it('rejects a response whose announced size exceeds maxBytes', async () => {
    await expect(fetchSafe(`${base}/huge`, { timeout: 5000, maxBytes: 1024 }))
      .rejects.toThrow(/Response too large/);
  });

  it('accepts a response within maxBytes', async () => {
    const response = await fetchSafe(`${base}/ok`, { timeout: 5000, maxBytes: 1024 });
    expect(response.ok).toBe(true);
    await response.text();
  });
});
