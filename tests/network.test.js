import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchSafe, readBodyWithLimit, resolveBudget, resolveMaxRequestDurationMs } from '../src/utils/network.js';
import * as helpers from '../src/utils/helpers.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('node-fetch');
vi.mock('../src/utils/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  isSafeUrl: vi.fn(),
  safeLookup: vi.fn(),
}));

describe('fetchSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch a safe URL successfully', async () => {
    const url = 'http://example.com';
    const destroy = vi.fn();
    const mockResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve('Success'),
      body: { destroy },
    };

    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue(mockResponse);

    const response = await fetchSafe(url);

    expect(helpers.isSafeUrl).toHaveBeenCalledWith(url);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({
      redirect: 'manual',
    }));
    expect(response).toBe(mockResponse);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('should throw an error for unsafe URLs', async () => {
    const url = 'http://unsafe.com';
    helpers.isSafeUrl.mockResolvedValue(false);

    await expect(fetchSafe(url)).rejects.toThrow(`Unsafe URL: ${url}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'caller'])('aborts when the %s cancels a request with an external signal', async (trigger) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let request;
    let failure;
    try {
      helpers.isSafeUrl.mockResolvedValue(true);
      fetch.mockImplementationOnce((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      }));
      request = fetchSafe('http://example.com', { signal: controller.signal, timeout: 25 })
        .catch(error => { failure = error; });

      await vi.advanceTimersByTimeAsync(0);
      if (trigger === 'caller') controller.abort();
      await vi.advanceTimersByTimeAsync(25);

      expect(failure).toMatchObject({ name: 'AbortError' });
      expect(controller.signal.aborted).toBe(trigger === 'caller');
    } finally {
      controller.abort();
      await request;
      vi.useRealTimers();
    }
  });

  it('should follow redirects for safe URLs', async () => {
    const initialUrl = 'http://example.com';
    const redirectUrl = 'http://example.com/redirected';
    const destroy = vi.fn();

    // First response: 301 Redirect
    const redirectResponse = {
      ok: false,
      status: 301,
      headers: { get: (name) => name === 'location' ? redirectUrl : null },
      body: { destroy },
    };

    // Second response: 200 OK
    const finalResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
    };

    helpers.isSafeUrl.mockResolvedValue(true);

    // Mock fetch to return redirect first, then success
    fetch
      .mockResolvedValueOnce(redirectResponse)
      .mockResolvedValueOnce(finalResponse);

    const response = await fetchSafe(initialUrl);

    expect(helpers.isSafeUrl).toHaveBeenCalledWith(initialUrl);
    expect(helpers.isSafeUrl).toHaveBeenCalledWith(redirectUrl);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, initialUrl, expect.any(Object));
    expect(fetch).toHaveBeenNthCalledWith(2, redirectUrl, expect.any(Object));
    expect(response).toBe(finalResponse);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('should handle relative redirects', async () => {
    const initialUrl = 'http://example.com/path';
    const relativeRedirect = '/new-path';
    const expectedNewUrl = 'http://example.com/new-path';

    const destroy = vi.fn();
    const redirectResponse = {
        ok: false,
        status: 302,
        headers: { get: (name) => name === 'location' ? relativeRedirect : null },
        body: { destroy },
    };

    const finalResponse = { ok: true, status: 200, headers: { get: () => null } };

    helpers.isSafeUrl.mockResolvedValue(true);

    fetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

    await fetchSafe(initialUrl);

    expect(fetch).toHaveBeenNthCalledWith(2, expectedNewUrl, expect.any(Object));
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('should destroy the redirect body when Location is invalid', async () => {
    const initialUrl = 'http://example.com';
    const destroy = vi.fn();
    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue({
      ok: false,
      status: 302,
      headers: { get: (name) => name === 'location' ? 'http://[invalid' : null },
      body: { destroy },
    });

    await expect(fetchSafe(initialUrl)).rejects.toThrow();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('should throw error on unsafe redirect', async () => {
    const initialUrl = 'http://example.com';
    const unsafeRedirect = 'http://unsafe-redirect.com';

    const destroy = vi.fn();
    const redirectResponse = {
      ok: false,
      status: 302,
      headers: { get: (name) => name === 'location' ? unsafeRedirect : null },
      body: { destroy },
    };

    // isSafeUrl returns true for initial, false for redirect
    helpers.isSafeUrl
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    fetch.mockResolvedValueOnce(redirectResponse);

    await expect(fetchSafe(initialUrl)).rejects.toThrow(`Unsafe URL: ${unsafeRedirect}`);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('should throw error after too many redirects', async () => {
    const url = 'http://example.com';
    const destroy = vi.fn();
    const redirectResponse = {
      ok: false,
      status: 302,
      headers: { get: (name) => name === 'location' ? url : null }, // Circular redirect
      body: { destroy },
    };

    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue(redirectResponse);

    await expect(fetchSafe(url, {}, 0)).rejects.toThrow('Too many redirects');
    // It should try 6 times (0 to 5 inclusive is 6 calls) then throw on the 7th attempt (redirectCount > 5)
    // Wait, let's trace:
    // Call 0: redirectCount=0. if(0>5) false. fetch(). returns 302. recursive fetch(url, {}, 1).
    // Call 1: redirectCount=1. ... recursive fetch(url, {}, 2).
    // ...
    // Call 5: redirectCount=5. if(5>5) false. fetch(). returns 302. recursive fetch(url, {}, 6).
    // Call 6: redirectCount=6. if(6>5) true. throw.
    // So fetch is called 6 times (0,1,2,3,4,5).
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(destroy).toHaveBeenCalledTimes(6);
  });

  it('should use correct agent for protocol', async () => {
    const httpUrl = 'http://example.com';
    const httpsUrl = 'https://example.com';

    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });

    // We need to capture the agent function passed to fetch
    await fetchSafe(httpUrl);
    const httpCallArgs = fetch.mock.calls[0][1];
    const httpAgentFn = httpCallArgs.agent;

    // Verify it returns httpAgent for http protocol
    // Note: The agent function takes a parsed URL object.
    const mockParsedHttpUrl = new URL(httpUrl);
    // In actual node-fetch usage, it might pass a parsed URL object.
    // Let's verify what our implementation does:
    // agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent)

    // We can import the agents to compare reference, but they are not exported from network.js easily
    // (unless we export them or mock the module to check internal usage).
    // Alternatively, we verify the logic of the function passed.

    expect(httpAgentFn(mockParsedHttpUrl)).toBeDefined();
    // We can't strictly compare to the un-exported httpAgent instance without rewiring.
    // However, we can check if it distinguishes protocols.

    // Let's try https
    fetch.mockClear();
    await fetchSafe(httpsUrl);
    const httpsCallArgs = fetch.mock.calls[0][1];
    const httpsAgentFn = httpsCallArgs.agent;
    const mockParsedHttpsUrl = new URL(httpsUrl);

    // Ensure the function behaves differently or returns different agents
    // Since we mocked network.js partially, the internal agents are real instances created in the module scope?
    // Actually, when we import { fetchSafe } from '../src/utils/network.js', the module executes.
    // The agents are created.
    // We can just verify the agent function logic.

    const agentForHttp = httpsAgentFn(new URL('http://test.com'));
    const agentForHttps = httpsAgentFn(new URL('https://test.com'));

    expect(agentForHttp).not.toBe(agentForHttps);
  });

  it('should disable HTTPS certificate verification only when self-signed certificates are allowed', async () => {
    const httpsUrl = 'https://example.com';

    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null } });

    await fetchSafe(httpsUrl);
    const defaultAgent = fetch.mock.calls[0][1].agent(new URL(httpsUrl));

    fetch.mockClear();
    await fetchSafe(httpsUrl, { allowSelfSigned: true });
    const selfSignedAgent = fetch.mock.calls[0][1].agent(new URL(httpsUrl));
    const fetchOptions = fetch.mock.calls[0][1];

    expect(defaultAgent.options.rejectUnauthorized).not.toBe(false);
    expect(selfSignedAgent.options.rejectUnauthorized).toBe(false);
    expect(fetchOptions).not.toHaveProperty('allowSelfSigned');
  });
});

describe('readBodyWithLimit', () => {
  // `Buffer#toString('utf8')` keeps a UTF-8 BOM where the `response.text()` /
  // `response.json()` calls this function replaced dropped it. Xtream panels are
  // typically PHP, where a stray BOM in an included file is a classic accident.
  const streamed = text => ({ body: Readable.from([Buffer.from(text, 'utf8')]) });

  it('drops a UTF-8 BOM so the manifest rewriter still sees the leading #', async () => {
    const text = await readBodyWithLimit(streamed('\uFEFF#EXTM3U\nhttp://cdn.example/seg.ts'));

    expect(text.startsWith('#EXTM3U')).toBe(true);
    // The rewriter skips comment lines with ^(?!#); a BOM displaces that anchor
    // and the #EXTM3U line gets replaced by a URL.
    expect(text.replace(/^(?!#)(.+)$/gm, 'REWRITTEN').split('\n')[0]).toBe('#EXTM3U');
  });

  it('parses JSON that arrives with a UTF-8 BOM', async () => {
    const data = await readBodyWithLimit(streamed('\uFEFF{"user_info":{"auth":1}}'), { as: 'json' });

    expect(data).toEqual({ user_info: { auth: 1 } });
  });

  it('leaves the BOM bytes alone when the caller wants the raw buffer', async () => {
    const buffer = await readBodyWithLimit(streamed('\uFEFFx'), { as: 'buffer' });

    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('settles at once when the body closes before it is complete', async () => {
    // A socket destroyed without an error — a shutdown, an upstream going away —
    // emits neither 'end' nor 'error'. The read used to wait out its whole
    // deadline for a body that could no longer arrive.
    const stalled = new Readable({ read() {} });
    stalled.push(Buffer.from('{"a":'));
    const started = Date.now();
    const pending = readBodyWithLimit({ body: stalled }, { as: 'json', timeoutMs: 60000 });
    setTimeout(() => stalled.destroy(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it('still returns a body that arrives normally', async () => {
    // The close handler must not disturb the ordinary path, where 'close'
    // follows 'end'.
    await expect(readBodyWithLimit(streamed('{"ok":true}'), { as: 'json' })).resolves.toEqual({ ok: true });
    await expect(readBodyWithLimit(streamed(''), { as: 'text' })).resolves.toBe('');
  });

  it('refuses a body past maxBytes', async () => {
    await expect(readBodyWithLimit(streamed('x'.repeat(2048)), { maxBytes: 512 }))
      .rejects.toThrow(/exceeded the 512 byte limit/);
  });
});

describe('fetchSafe error redaction', () => {
  beforeEach(() => vi.clearAllMocks());

  const credentialUrl = 'http://panel.example:8080/player_api.php?username=alice&password=s3cr3t&action=get_series_info';

  it('strips the credentials node-fetch puts in its error message', async () => {
    // node-fetch builds `request to ${url} failed, reason: …`, and a provider
    // URL carries the panel password. Every caller that logged a failed fetch
    // printed that password to stdout.
    helpers.isSafeUrl.mockResolvedValue(true);
    const upstream = new Error(`request to ${credentialUrl} failed, reason: connect ECONNREFUSED 10.0.0.1:8080`);
    upstream.code = 'ECONNREFUSED';
    upstream.type = 'system';
    fetch.mockRejectedValue(upstream);

    const error = await fetchSafe(credentialUrl).catch(e => e);

    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).not.toContain('password=');
    // Still diagnosable: host, path and the system code survive.
    expect(error.message).toContain('panel.example:8080/player_api.php');
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.code).toBe('ECONNREFUSED');
  });

  it('keeps the abort name so callers can still branch on it', async () => {
    helpers.isSafeUrl.mockResolvedValue(true);
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    fetch.mockRejectedValue(abort);

    const error = await fetchSafe(credentialUrl).catch(e => e);

    expect(error.name).toBe('AbortError');
  });

  it('does not repeat the credentials when refusing an unsafe URL', async () => {
    helpers.isSafeUrl.mockResolvedValue(false);

    const error = await fetchSafe(credentialUrl).catch(e => e);

    expect(error.message).not.toContain('s3cr3t');
    expect(error.message).toContain('panel.example:8080');
  });
});

describe('resolveBudget', () => {
  it('falls back instead of disabling the cap it was set to tighten', () => {
    // `Number(raw) || fallback` let a negative through, because it is truthy,
    // and readBodyWithLimit reads a negative maxBytes as no limit at all.
    expect(resolveBudget('-1', 1000, 10)).toBe(1000);
    expect(resolveBudget('0', 1000, 10)).toBe(1000);
    expect(resolveBudget('', 1000, 10)).toBe(1000);
    expect(resolveBudget(undefined, 1000, 10)).toBe(1000);
    expect(resolveBudget('nonsense', 1000, 10)).toBe(1000);
  });

  it('refuses a value with a unit suffix instead of reading its leading digits', () => {
    // parseInt reads `30s` as 30 and `512MB` as 512. Flooring that turns a five
    // minute budget into one second and a 512 MB cap into 1 MB — worse than the
    // `Number(raw) || default` it replaced, which at least fell back. The
    // default is the one outcome never worse than what the operator meant.
    expect(resolveBudget('30s', 60000, 1000)).toBe(60000);
    expect(resolveBudget('10m', 60000, 1000)).toBe(60000);
    expect(resolveBudget('512MB', 536870912, 1048576)).toBe(536870912);
    expect(resolveBudget('1e9', 33554432, 65536)).toBe(33554432);
    // A value meant literally is still honoured, and still bounded.
    expect(resolveBudget('45000', 60000, 1000)).toBe(45000);
    expect(resolveBudget(' 500 ', 60000, 1000)).toBe(1000);
  });

  it('caps at the maximum when one is given', () => {
    expect(resolveBudget('999999', 100, 1, 500)).toBe(500);
  });

  it('names the variable when it replaces or clamps a value', () => {
    // A silently replaced value leaves the operator looking at the symptom —
    // every request timing out — with nothing pointing at the cause.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveBudget('30s', 60000, 1000, Number.MAX_SAFE_INTEGER, 'DEMO_MS');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEMO_MS="30s"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no unit suffixes'));
      warn.mockClear();

      resolveBudget('-5', 60000, 1000, Number.MAX_SAFE_INTEGER, 'DEMO_MS');
      expect(warn).toHaveBeenCalled();
      warn.mockClear();

      // An unset variable is not a misconfiguration.
      resolveBudget(undefined, 60000, 1000, Number.MAX_SAFE_INTEGER, 'DEMO_MS');
      resolveBudget('45000', 60000, 1000, Number.MAX_SAFE_INTEGER, 'DEMO_MS');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never lets the global request budget be shortened by a typo', () => {
    // This gates every outgoing request; ten milliseconds — which is what `10m`
    // parses to — takes the instance offline with an AbortError that looks
    // exactly like an upstream timeout.
    expect(resolveMaxRequestDurationMs('10m')).toBe(600000);
    expect(resolveMaxRequestDurationMs('10')).toBe(1000);      // meant literally: floored
    expect(resolveMaxRequestDurationMs('-5')).toBe(600000);
    expect(resolveMaxRequestDurationMs(undefined)).toBe(600000);
    expect(resolveMaxRequestDurationMs('900000')).toBe(900000);
  });
});

describe('readBodyWithLimit deadline', () => {
  it('settles rather than letting the process exit with the read pending', () => {
    // The deadline timer was unref'd. For a socket-backed body the socket holds
    // the loop open, so that hid; for any other stream it meant the documented
    // timeout never arrived and the process exited with the await unsettled
    // (exit code 13). A test runner keeps its own loop alive, so this needs a
    // process of its own.
    const network = fileURLToPath(new URL('../src/utils/network.js', import.meta.url));
    const script = `
      import { Readable } from 'node:stream';
      import { readBodyWithLimit } from ${JSON.stringify(network)};
      const orphan = new Readable({ read() {} });
      try {
        await readBodyWithLimit({ body: orphan }, { timeoutMs: 300 });
        console.log('RESOLVED');
      } catch (e) {
        console.log('SETTLED ' + e.name);
      }
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 20000,
    });

    expect(run.status).toBe(0);
    expect(run.stderr).not.toMatch(/unsettled top-level await/);
    expect(run.stdout.trim()).toBe('SETTLED AbortError');
  }, 30000);
});
