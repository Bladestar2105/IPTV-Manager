import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import dns from 'node:dns';

// The SSRF guard blocks loopback addresses. Allow the local fixture server
// through, but keep the real DNS lookup so the agent still behaves normally.
vi.mock('../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  isSafeUrl: async () => true,
  safeLookup: (hostname, options, callback) => dns.lookup(hostname, options, callback),
}));

const { armStreamDeadline, fetchSafe, readBodyWithLimit, resolveMaxRequestDurationMs } =
  await import('../src/utils/network.js');

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

  it('aborts a stalled body through the bounded reader', async () => {
    // fetchSafe deliberately leaves the body alone — most bodies it returns are
    // piped to a player. A caller that buffers a finite document bounds the read.
    const response = await fetchSafe(`${base}/stalled-body`, { timeout: 5000 });
    expect(response.ok).toBe(true);

    const started = Date.now();
    await expect(readBodyWithLimit(response, { timeoutMs: 500 }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('leaves a piped body running, so a live stream is never cut', async () => {
    // Regression guard: bounding every body by default cut each live session at
    // the deadline, on the most-used endpoint in the app.
    const response = await fetchSafe(`${base}/stalled-body`, { timeout: 5000, maxDurationMs: 300 });
    expect(response.ok).toBe(true);

    const errored = new Promise(resolve => response.body.once('error', () => resolve('aborted')));
    response.body.on('data', () => {});
    const outcome = await Promise.race([
      errored,
      new Promise(resolve => setTimeout(() => resolve('still streaming'), 1200)),
    ]);
    response.body.destroy();
    expect(outcome).toBe('still streaming');
  }, 15000);

  it('treats maxDurationMs as a hard cap for the headers even below the header timeout', async () => {
    const started = Date.now();
    await expect(fetchSafe(`${base}/slow-headers`, { timeout: 30000, maxDurationMs: 400 }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15000);

  it('rejects a body that exceeds the read size cap', async () => {
    const response = await fetchSafe(`${base}/ok`, { timeout: 5000 });
    await expect(readBodyWithLimit(response, { maxBytes: 4 })).rejects.toThrow(/Response too large/);
  }, 15000);

  it('reads a finite body as json', async () => {
    const response = await fetchSafe(`${base}/ok`, { timeout: 5000 });
    await expect(readBodyWithLimit(response, { as: 'json' })).resolves.toEqual({ ok: true });
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

describe('armStreamDeadline', () => {
  it('destroys a stream that never finishes', async () => {
    // For consumers that parse from the stream instead of buffering it, where
    // readBodyWithLimit does not apply — the M3U playlist and the EPG feed.
    const response = await fetchSafe(`${base}/stalled-body`, { timeout: 5000 });
    const disarm = armStreamDeadline(response.body, 300, 'too slow');

    const outcome = await new Promise(resolve => {
      response.body.on('data', () => {});
      response.body.once('error', e => resolve(e.message));
      setTimeout(() => resolve('still open'), 2000);
    });
    disarm();
    expect(outcome).toBe('too slow');
  }, 15000);

  it('does nothing once disarmed', async () => {
    const response = await fetchSafe(`${base}/stalled-body`, { timeout: 5000 });
    const disarm = armStreamDeadline(response.body, 200, 'too slow');
    disarm();

    const outcome = await new Promise(resolve => {
      response.body.on('data', () => {});
      response.body.once('error', () => resolve('destroyed'));
      setTimeout(() => resolve('still open'), 800);
    });
    response.body.destroy();
    expect(outcome).toBe('still open');
  }, 15000);

  it('tolerates a value that is not a stream', () => {
    expect(() => armStreamDeadline(null, 100)()).not.toThrow();
    expect(() => armStreamDeadline({}, 100)()).not.toThrow();
  });
});
