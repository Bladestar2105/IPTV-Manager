import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSafe } from '../src/utils/network.js';
import * as helpers from '../src/utils/helpers.js';
import fetch from 'node-fetch';

// Mock dependencies
vi.mock('node-fetch');
vi.mock('../src/utils/helpers.js', () => ({
  isSafeUrl: vi.fn(),
  safeLookup: vi.fn(),
}));

describe('fetchSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch a safe URL successfully', async () => {
    const url = 'http://example.com';
    const mockResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve('Success'),
    };

    helpers.isSafeUrl.mockResolvedValue(true);
    fetch.mockResolvedValue(mockResponse);

    const response = await fetchSafe(url);

    expect(helpers.isSafeUrl).toHaveBeenCalledWith(url);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({
      redirect: 'manual',
    }));
    expect(response).toBe(mockResponse);
  });

  it('should throw an error for unsafe URLs', async () => {
    const url = 'http://unsafe.com';
    helpers.isSafeUrl.mockResolvedValue(false);

    await expect(fetchSafe(url)).rejects.toThrow(`Unsafe URL: ${url}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should follow redirects for safe URLs', async () => {
    const initialUrl = 'http://example.com';
    const redirectUrl = 'http://example.com/redirected';

    // First response: 301 Redirect
    const redirectResponse = {
      ok: false,
      status: 301,
      headers: { get: (name) => name === 'location' ? redirectUrl : null },
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
  });

  it('should handle relative redirects', async () => {
    const initialUrl = 'http://example.com/path';
    const relativeRedirect = '/new-path';
    const expectedNewUrl = 'http://example.com/new-path';

    const redirectResponse = {
        ok: false,
        status: 302,
        headers: { get: (name) => name === 'location' ? relativeRedirect : null },
    };

    const finalResponse = { ok: true, status: 200, headers: { get: () => null } };

    helpers.isSafeUrl.mockResolvedValue(true);

    fetch.mockResolvedValueOnce(redirectResponse).mockResolvedValueOnce(finalResponse);

    await fetchSafe(initialUrl);

    expect(fetch).toHaveBeenNthCalledWith(2, expectedNewUrl, expect.any(Object));
  });

  it('should throw error on unsafe redirect', async () => {
    const initialUrl = 'http://example.com';
    const unsafeRedirect = 'http://unsafe-redirect.com';

    const redirectResponse = {
      ok: false,
      status: 302,
      headers: { get: (name) => name === 'location' ? unsafeRedirect : null },
    };

    // isSafeUrl returns true for initial, false for redirect
    helpers.isSafeUrl
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    fetch.mockResolvedValueOnce(redirectResponse);

    await expect(fetchSafe(initialUrl)).rejects.toThrow(`Unsafe URL: ${unsafeRedirect}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should throw error after too many redirects', async () => {
    const url = 'http://example.com';
    const redirectResponse = {
      ok: false,
      status: 302,
      headers: { get: (name) => name === 'location' ? url : null }, // Circular redirect
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
});
