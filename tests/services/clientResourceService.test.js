import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, getXtreamUser, isIpAllowedForUser } = vi.hoisted(() => ({
  db: { prepare: vi.fn() }, getXtreamUser: vi.fn(), isIpAllowedForUser: vi.fn(() => true)
}));
vi.mock('../../src/database/db.js', () => ({ default: db }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn(() => 'https://epg.example/current.png') }));

import { createClientResourceUrl, createChannelIconUrl, resolveClientResource, rewriteClientMetadata } from '../../src/services/clientResourceService.js';
import { upstreamRequestHeaders, withUpstreamCookies } from '../../src/utils/clientCookies.js';

const user = { id: 7, token_version: 2, is_active: 1, webui_access: 0 };
const request = () => ({ protocol: 'https', get: name => name === 'host' ? 'manager.example' : undefined,
  app: { get: () => false }, query: {}, params: {}, ip: '203.0.113.2' });
function resourceRequest(url) {
  const parsed = new URL(url);
  return { ...request(), params: { data: parsed.pathname.split('/')[4] }, query: Object.fromEntries(parsed.searchParams) };
}

describe('scoped client resource URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isIpAllowedForUser.mockReturnValue(true);
    getXtreamUser.mockResolvedValue(user);
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : undefined }));
  });

  it('hides provider URLs and credentials and works without WebUI access', async () => {
    const upstream = 'https://provider.example/icon.png?password=upstream-secret';
    const url = createClientResourceUrl(request(), user, upstream);
    expect(url).toMatch(/^https:\/\/manager\.example\/api\/proxy\/resource\//);
    expect(url).not.toContain('provider');
    expect(url).not.toContain('upstream-secret');
    expect(await resolveClientResource(resourceRequest(url))).toMatchObject({ url: upstream, user, kind: 'image' });
  });

  it('rejects tampered, revoked, expired and region-blocked resource grants', async () => {
    const url = createClientResourceUrl(request(), user, 'https://provider.example/icon.png');
    const req = resourceRequest(url);
    req.params.data = `x${req.params.data}`;
    expect(await resolveClientResource(req)).toBeNull();
    for (const replacement of [null, { ...user, token_version: 3 }, { ...user, is_active: 0 }, { ...user, expiry_date: '2020-01-01' }]) {
      db.prepare.mockReturnValue({ get: () => replacement });
      expect(await resolveClientResource(resourceRequest(url))).toBeNull();
    }
    db.prepare.mockReturnValue({ get: () => user });
    isIpAllowedForUser.mockReturnValue(false);
    expect(await resolveClientResource(resourceRequest(url))).toBeNull();
  });

  it('rechecks share/session token authorization instead of making grants outlive it', async () => {
    const req = request(); req.query.token = 'share-token';
    const url = createClientResourceUrl(req, { ...user, is_share_guest: true }, 'https://provider.example/icon.png');
    getXtreamUser.mockResolvedValue(null);
    expect(await resolveClientResource(resourceRequest(url))).toBeNull();
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, share_end: 1 });
    expect(await resolveClientResource(resourceRequest(url))).toBeNull();
  });

  it('resolves channel icons from the current catalog even when the client keeps its old URL', async () => {
    const url = createChannelIconUrl(request(), user, 51);
    let logo = 'https://provider.example/old.png';
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : { logo, provider_id: 8 } }));
    expect((await resolveClientResource(resourceRequest(url))).url).toBe(logo);
    logo = 'https://provider.example/new.png';
    expect((await resolveClientResource(resourceRequest(url))).url).toBe(logo);
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : undefined }));
    expect(await resolveClientResource(resourceRequest(url))).toBeNull();
  });

  it('rejects a channel icon outside a share scope', async () => {
    const req = request(); req.query.token = 'share-token';
    const url = createChannelIconUrl(req, { ...user, is_share_guest: true }, 51);
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [52] });
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : { logo: 'https://provider.example/a.png' } }));
    expect(await resolveClientResource(resourceRequest(url))).toBeNull();
  });
  it.each([
    ['//cdn.example/logo.png', 'https://cdn.example/logo.png'],
    ['/icons/logo.png', 'https://provider.example/icons/logo.png'],
    ['icons/logo.png', 'https://provider.example/catalog/icons/logo.png'],
  ])('resolves current provider icon %s against the provider catalog origin', async (logo, expected) => {
    const url = createChannelIconUrl(request(), user, 51);
    db.prepare.mockImplementation(sql => ({ get: () => sql.includes('FROM users') ? user : { logo, provider_id: 8, provider_url: 'https://provider.example/catalog/list.m3u' } }));
    expect(await resolveClientResource(resourceRequest(url))).toMatchObject({ url: expected });
  });

  it('keeps DASH substitution tokens visible while validating substituted values', async () => {
    const url = createClientResourceUrl(request(), user, 'https://cdn.example/$RepresentationID$/seg-$Number%05d$.m4s', { kind: 'resource', template: true });
    expect(url).toContain('$RepresentationID$');
    expect(url).toContain('$Number%05d$');
    const filled = url.replace('$RepresentationID$', 'video-1').replace('$Number%05d$', '00023');
    expect((await resolveClientResource(resourceRequest(filled))).url).toBe('https://cdn.example/video-1/seg-00023.m4s');
    const req = resourceRequest(filled); req.query.tpl0 = '../secret';
    expect(await resolveClientResource(req)).toBeNull();
  });
  it.each(['video:main=1080', 'Bild ä', 'video..main', 'track?x=1&y=2#part', '100%'])('accepts and safely encodes DASH representation ID %s', async id => {
    const url = createClientResourceUrl(request(), user, 'https://cdn.example/$RepresentationID$/seg-$Number$.m4s', { kind: 'resource' });
    const req = resourceRequest(url); req.query.tpl0 = id; req.query.tpl1 = '23';
    expect(await resolveClientResource(req)).toMatchObject({ url: `https://cdn.example/${encodeURIComponent(id)}/seg-23.m4s` });
  });
  it.each(['..', '%2e%2e%2fsecret', '../secret', '..\\secret', 'bad\nheader'])('rejects unsafe DASH representation ID %s', async id => {
    const url = createClientResourceUrl(request(), user, 'https://cdn.example/$RepresentationID$/seg.m4s', { kind: 'resource' });
    const req = resourceRequest(url); req.query.tpl0 = id;
    expect(await resolveClientResource(req)).toBeNull();
  });

  it('rewrites nested artwork, subtitles and license URLs without leaking stream sources or headers', async () => {
    const rewritten = rewriteClientMetadata(request(), user, {
      cover: '//provider.example/poster.jpg', backdrop_path: ['https://cdn.example/bg.jpg'],
      nested: { subtitle: 'https://provider.example/sub.vtt', direct_source: 'https://provider.example/stream.ts',
        original_url: 'https://provider.example/live', http_headers: { Authorization: 'secret' }, password: 'secret' },
      drm: { license_type: 'com.widevine.alpha', license_key: 'https://drm.example/license|Authorization=Bearer%20secret' }
    });
    const json = JSON.stringify(rewritten);
    expect(json).not.toContain('provider.example');
    expect(json).not.toContain('cdn.example');
    expect(json).not.toContain('secret');
    expect(rewritten.nested.direct_source).toBe('');
    expect(rewritten.nested).not.toHaveProperty('http_headers');
    expect(rewritten.nested).not.toHaveProperty('password');
    expect(await resolveClientResource(resourceRequest(rewritten.drm.license_key))).toMatchObject({
      kind: 'license', url: 'https://drm.example/license', headers: { Authorization: 'Bearer secret' }
    });
  });

  it('binds explicitly encoded license authorization to the license origin while retaining cookie scope', async () => {
    const context = withUpstreamCookies({ Authorization: 'Bearer panel-secret' }, {
      url: 'https://panel.example.com/main.mpd', headers: { getSetCookie: () => ['session=panel-secret; Path=/'] },
    }, 'https://panel.example.com/main.mpd');
    const rewritten = rewriteClientMetadata(request(), user, {
      license_key: 'https://drm.example/license|Authorization=Bearer%20license-secret&Cookie=license%3Dexplicit',
    }, '', context);
    const resource = await resolveClientResource(resourceRequest(rewritten.license_key));
    const headers = new Headers(upstreamRequestHeaders(resource, resource.url));
    expect(headers.get('authorization')).toBe('Bearer license-secret');
    expect(headers.get('cookie')).toBe('license=explicit');
    expect(new Headers(upstreamRequestHeaders(resource, 'https://other.example/license')).get('cookie')).toBeNull();
  });
  it('resolves recognized relative JSON resource fields without rewriting descriptive text', async () => {
    const rewritten = rewriteClientMetadata(request(), user, {
      title: 'Movie title', plot: 'A story about captions/en.vtt', youtube_trailer: 'dQw4w9WgXcQ',
      trailer: '../trailers/movie.mp4',
      subtitle: 'captions/en.vtt', poster: '../cover.jpg', logo: 'logo.png',
      subtitles: [{ language: 'en', url: '/subs/en.vtt' }],
      drm: { license_type: 'com.widevine.alpha', license_key: '../license|Authorization=Bearer%20secret', licenseUrl: './alternate-license' },
    }, '', { baseUrl: 'https://cdn.example/metadata/info.json' });
    expect(rewritten.title).toBe('Movie title');
    expect(rewritten.youtube_trailer).toBe('dQw4w9WgXcQ');
    expect(await resolveClientResource(resourceRequest(rewritten.trailer))).toMatchObject({ url: 'https://cdn.example/trailers/movie.mp4' });
    expect(rewritten.plot).toBe('A story about captions/en.vtt');
    expect(rewritten.subtitles[0].language).toBe('en');
    for (const [url, expected] of [[rewritten.subtitle, 'https://cdn.example/metadata/captions/en.vtt'], [rewritten.poster, 'https://cdn.example/cover.jpg'], [rewritten.logo, 'https://cdn.example/metadata/logo.png'], [rewritten.subtitles[0].url, 'https://cdn.example/subs/en.vtt']]) {
      expect(await resolveClientResource(resourceRequest(url))).toMatchObject({ url: expected });
    }
    expect(await resolveClientResource(resourceRequest(rewritten.drm.license_key))).toMatchObject({ url: 'https://cdn.example/license', kind: 'license', headers: { Authorization: 'Bearer secret' } });
    expect(await resolveClientResource(resourceRequest(rewritten.drm.licenseUrl))).toMatchObject({ url: 'https://cdn.example/metadata/alternate-license', kind: 'license' });
  });
  it('keeps YouTube trailer links direct without exempting unrelated provider URLs', () => {
    const value = {
      youtube_trailer: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      trailer: 'https://youtu.be/dQw4w9WgXcQ',
      nested: { trailer_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' },
      poster: 'https://provider.example/poster.jpg',
      unrelated: { trailer: 'https://youtube.com.provider.example/video.mp4' },
    };
    const result = rewriteClientMetadata(request(), user, value, '', { baseUrl: 'https://provider.example/details.json' });
    expect(result.youtube_trailer).toBe(value.youtube_trailer);
    expect(result.trailer).toBe(value.trailer);
    expect(result.nested.trailer_url).toBe(value.nested.trailer_url);
    expect(result.poster).toContain('/api/proxy/resource/');
    expect(result.unrelated.trailer).toContain('/api/proxy/resource/');
  });

  it('does not wrap Manager URLs again and blocks unsafe schemes and protocol-relative bypasses', () => {
    const req = request();
    const existing = createClientResourceUrl(req, user, 'https://provider.example/image.png');
    expect(createClientResourceUrl(req, user, existing)).toBe(existing);
    const forged = 'https://manager.example/api/proxy/resource/opaque/image.png?password=secret';
    expect(createClientResourceUrl(req, user, forged)).not.toContain('password=secret');
    expect(createClientResourceUrl(req, user, 'javascript:alert(1)')).toBe('');
    expect(createClientResourceUrl(req, user, 'file:///tmp/secrets')).toBe('');
    expect(createClientResourceUrl(req, user, '//provider.example/a.png')).toMatch(/^https:\/\/manager.example\//);
  });
  it.each([false, true])('does not trust a matching request origin to identify Manager-owned URLs (forwarded=%s)', forwarded => {
    const req = request();
    req.get = name => name === 'x-forwarded-host' && forwarded ? 'provider.example' : name === 'host' ? (forwarded ? 'manager.example' : 'provider.example') : undefined;
    req.app.get = () => forwarded;
    const rewritten = rewriteClientMetadata(req, user, {
      backdrop_path: ['https://provider.example/cover.jpg?password=upstream-secret'],
      drm: { license_key: 'https://provider.example/license?token=provider-secret' }
    });
    expect(rewritten.backdrop_path[0]).toContain('/api/proxy/resource/');
    expect(rewritten.drm.license_key).toContain('/api/proxy/resource/');
    expect(JSON.stringify(rewritten)).not.toContain('upstream-secret');
    expect(JSON.stringify(rewritten)).not.toContain('provider-secret');
  });
  it('does not preserve added credentials on otherwise valid Manager resource URLs', () => {
    const req = request();
    const original = createClientResourceUrl(req, user, 'https://provider.example/image.png');
    const malicious = original + '?password=upstream-secret';
    expect(createClientResourceUrl(req, user, malicious)).not.toContain('upstream-secret');
  });
});
