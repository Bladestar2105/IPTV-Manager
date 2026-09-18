import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetchSafe hands back a live socket: it bounds the wait for the headers and
// then gets out of the way, because most bodies it returns are media. A caller
// that reads the status and then abandons the response leaves that socket
// holding a body nothing consumes — and these agents set neither keepAlive nor
// a socket timeout. A panel that answers every section with an error page
// therefore strands one socket per section per sync, on every worker, for as
// long as the panel stays broken.

const { fetchSafe, parseM3uStream } = vi.hoisted(() => ({
  fetchSafe: vi.fn(), parseM3uStream: vi.fn(),
}));

vi.mock('../src/utils/network.js', async importOriginal => ({
  ...(await importOriginal()), fetchSafe,
}));
vi.mock('../src/utils/playlistParser.js', () => ({ parseM3uStream }));
vi.mock('@iptv/xtream-api', () => ({ Xtream: class {} }));

const { discardBody } = await import('../src/utils/network.js');
const { fetchProviderCatalog } = await import('../src/services/providerCatalogSyncService.js');

/** A response whose body records whether anything threw it away. */
const responseDouble = (status, headers = {}) => {
  const body = { destroyed: false, destroy() { this.destroyed = true; } };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    body,
  };
};

describe('discardBody', () => {
  it('destroys a body nobody is going to read', () => {
    const response = responseDouble(502);
    discardBody(response);
    expect(response.body.destroyed).toBe(true);
  });

  it('leaves an already-destroyed body alone', () => {
    const response = responseDouble(502);
    response.body.destroyed = true;
    response.body.destroy = () => { throw new Error('destroy called twice'); };
    expect(() => discardBody(response)).not.toThrow();
  });

  it('accepts anything a caller might hand it', () => {
    expect(() => discardBody(undefined)).not.toThrow();
    expect(() => discardBody({})).not.toThrow();
    expect(() => discardBody({ body: null })).not.toThrow();
    expect(() => discardBody({ body: { destroy: () => { throw new Error('nope'); } } })).not.toThrow();
  });
});

describe('fetchProviderCatalog', () => {
  const provider = { id: 1, url: 'http://panel.example:8080', username: 'u', password: 'p' };
  const xtream = { getChannels: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    xtream.getChannels.mockRejectedValue(new Error('no xtream'));
    parseM3uStream.mockResolvedValue({ isM3u: false, channels: [], categories: [] });
  });

  it('strands no socket when every section answers with an error', async () => {
    const responses = [];
    fetchSafe.mockImplementation(() => {
      const response = responseDouble(502);
      responses.push(response);
      return Promise.resolve(response);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const result = await fetchProviderCatalog(provider, xtream);

    expect(responses.length).toBeGreaterThanOrEqual(3);
    expect(responses.filter(r => !r.body.destroyed)).toEqual([]);
    // And the run is still reported as a failure, not as an empty catalog.
    expect(result.failures.length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  it('throws away a body it refuses for its content type', async () => {
    const html = responseDouble(200, { 'content-type': 'text/html' });
    fetchSafe.mockImplementation(url => Promise.resolve(
      String(url).includes('get_live_streams') ? html : responseDouble(502)));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    await fetchProviderCatalog(provider, xtream);

    expect(html.body.destroyed).toBe(true);
    vi.restoreAllMocks();
  });
});
