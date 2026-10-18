import { describe, it, expect } from 'vitest';
import * as cookies from '../src/utils/clientCookies.js';

const response = (url, values) => ({ url, headers: { raw: () => ({ 'set-cookie': values }) } });
const header = (context, url) => new Headers(cookies.upstreamRequestHeaders(context, url)).get('cookie');

describe('scoped upstream cookie propagation', () => {
  it('keeps host-only cookies away from sibling CDNs and license servers', () => {
    const context = cookies.withUpstreamCookies({}, response('https://panel.example.com/live/main.m3u8', ['session=secret; Path=/']), 'https://panel.example.com/live/main.m3u8');
    expect(header(context, 'https://panel.example.com/live/chunk.ts')).toBe('session=secret');
    expect(header(context, 'https://cdn.example.com/chunk.ts')).toBeNull();
    expect(header(context, 'https://license.example.net/key')).toBeNull();
    expect(context.headers).not.toHaveProperty('Cookie');
  });

  it('honors Domain, Path, Secure and rejects public suffix and unrelated Domain cookies', () => {
    const context = cookies.withUpstreamCookies({}, response('https://panel.example.com/live/main.m3u8', [
      'shared=yes; Domain=example.com; Path=/live; Secure',
      'bad=secret; Domain=com; Path=/', 'other=secret; Domain=other.example; Path=/',
    ]), 'https://panel.example.com/live/main.m3u8');
    expect(header(context, 'https://cdn.example.com/live/chunk.ts')).toBe('shared=yes');
    expect(header(context, 'https://cdn.example.com/livestream/chunk.ts')).toBeNull();
    expect(header(context, 'http://cdn.example.com/live/chunk.ts')).toBeNull();
    expect(header(context, 'https://unrelated.com/live/chunk.ts')).toBeNull();
  });

  it('retains default paths and cookie deletion across serialized nested grants', () => {
    const first = cookies.withUpstreamCookies({}, response('https://panel.example.com/live/main.m3u8', [
      'session=one', 'gone=old; Path=/', 'expired=no; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/',
    ]), 'https://panel.example.com/live/main.m3u8');
    const next = cookies.withUpstreamCookies(first.headers, response('https://panel.example.com/live/child.m3u8', [
      'session=two', 'gone=; Max-Age=0; Path=/',
    ]), 'https://panel.example.com/live/child.m3u8', JSON.parse(JSON.stringify(first.cookieJar)), first.headerOrigin);
    expect(header(next, 'https://panel.example.com/live/chunk.ts')).toBe('session=two');
    expect(header(next, 'https://panel.example.com/elsewhere/chunk.ts')).toBeNull();
  });

  it('binds explicit Cookie and authorization to their original upstream scope', () => {
    const context = cookies.createUpstreamContext({ cOoKiE: 'session=initial', Authorization: 'Bearer secret', 'Proxy-Authorization': 'Basic secret' }, 'https://panel.example.com/live/main.m3u8');
    expect(header(context, 'https://panel.example.com/live/child.m3u8')).toBe('session=initial');
    expect(header(context, 'https://panel.example.com/other/key')).toBeNull();
    expect(header(context, 'http://panel.example.com/live/chunk.ts')).toBeNull();
    const foreign = new Headers(cookies.upstreamRequestHeaders(context, 'https://cdn.example.com/live/chunk.ts'));
    expect(foreign.get('cookie')).toBeNull();
    expect(foreign.get('authorization')).toBeNull();
    expect(foreign.get('proxy-authorization')).toBeNull();
    expect(new Headers(cookies.upstreamRequestHeaders(context, 'https://panel.example.com/live/chunk.ts')).get('authorization')).toBe('Bearer secret');
  });
});
