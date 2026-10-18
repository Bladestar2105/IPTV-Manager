import { describe, it, expect } from 'vitest';
import { rewriteHlsManifest, rewriteDashManifest } from '../src/utils/clientManifests.js';

describe('client manifest resources', () => {
  it('maps HLS playlists, keys, maps, subtitles, session data and preload resources', () => {
    const urls = [];
    const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="//cdn.example/subs.m3u8"\n#EXT-X-SESSION-DATA:DATA-ID="x",URI="meta.json"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part.m4s"\nchild.m3u8\n';
    const result = rewriteHlsManifest(manifest, 'https://origin.example/live/master.m3u8', url => { urls.push(url); return `https://manager.test/${urls.length}`; });
    expect(urls).toEqual(['https://origin.example/key', 'https://origin.example/live/init.mp4', 'https://cdn.example/subs.m3u8', 'https://origin.example/live/meta.json', 'https://origin.example/live/part.m4s', 'https://origin.example/live/child.m3u8']);
    expect(result).not.toContain('cdn.example');
    expect(result).toContain('URI="https://manager.test/1"');
  });
  it('resolves nested DASH base URLs and preserves template substitution for the mapper', () => {
    const urls = [];
    const manifest = '<MPD><BaseURL>//cdn.example/root/</BaseURL><Period><BaseURL>period/</BaseURL><AdaptationSet><Representation><BaseURL>video/</BaseURL><SegmentTemplate media="$RepresentationID$/$Number%05d$.m4s?a=1&amp;b=2" initialization="https://other.example/init.mp4"/><SegmentList><SegmentURL media="chunk.m4s"/><Initialization sourceURL="init.mp4"/></SegmentList></Representation></AdaptationSet></Period></MPD>';
    const result = rewriteDashManifest(manifest, 'https://origin.example/live/manifest.mpd', (url, options) => { urls.push([url, options]); return 'https://manager.test/resource'; });
    expect(urls).toContainEqual(['https://cdn.example/root/period/video/$RepresentationID$/$Number%05d$.m4s?a=1&b=2', { template: true }]);
    expect(urls.map(([url]) => url)).toContain('https://other.example/init.mp4');
    expect(urls.map(([url]) => url)).toContain('https://cdn.example/root/period/video/chunk.m4s');
    expect(result).not.toMatch(/cdn\.example|other\.example/);
  });
  it('maps DASH BaseURL once and applies xml:base before its child base', () => {
    const urls = [];
    rewriteDashManifest('<MPD xml:base="https://cdn.example/root/"><BaseURL>media/</BaseURL><Period><BaseURL>period/</BaseURL><SegmentTemplate media="chunk-$Number$.m4s"/></Period></MPD>', 'https://origin/a.mpd', url => { urls.push(url); return 'https://manager.test/resource'; });
    expect(urls).toContain('https://cdn.example/root/media/');
    expect(urls).toContain('https://cdn.example/root/media/period/');
    expect(urls).toContain('https://cdn.example/root/media/period/chunk-$Number$.m4s');
    expect(urls).not.toContain('https://cdn.example/root/media/period/period/');
  });
  it('expands HLS variables and passes them into nested playlist context', () => {
    const urls = [];
    const output = rewriteHlsManifest('#EXTM3U\n#EXT-X-DEFINE:NAME="host",VALUE="https://cdn.example"\n{$host}/child.m3u8', 'https://origin/a.m3u8', (url, options) => { urls.push([url, options]); return 'https://manager.test/resource'; });
    expect(urls).toContainEqual(['https://cdn.example/child.m3u8', { hlsVariables: { host: 'https://cdn.example' } }]);
    expect(output).not.toContain('cdn.example');
    const imported = rewriteHlsManifest('#EXTM3U\n#EXT-X-DEFINE:IMPORT="host"\n{$host}/chunk.ts', 'https://origin/b.m3u8', url => url, { host: 'https://cdn.example' });
    expect(imported).toContain('https://cdn.example/chunk.ts');
  });
  it('maps DASH license URLs, XLink fragments and steering documents', () => {
    const urls = [];
    const result = rewriteDashManifest('<MPD><Period xlink:href="period.xml"/><ContentProtection><dashif:Laurl licenseUrl="https://license.example/api"/></ContentProtection><ContentSteering>https://steering.example/dash.json</ContentSteering><Location><![CDATA[https://origin.example/new.mpd?x=1&y=2]]></Location></MPD>', 'https://origin.example/manifest.mpd', (url, options) => { urls.push([url, options]); return 'https://manager.test/resource'; });
    expect(urls).toContainEqual(['https://origin.example/period.xml', { template: false, manifestKind: 'dash' }]);
    expect(urls).toContainEqual(['https://license.example/api', { template: false, kind: 'license' }]);
    expect(urls.map(([url]) => url)).not.toContain('https://steering.example/dash.json');
    expect(urls.map(([url]) => url)).toContain('https://origin.example/new.mpd?x=1&y=2');
    expect(result).not.toMatch(/license\.example|steering\.example|origin\.example/);
  });
  it('removes optional HLS steering to keep client host substitution inside Manager', () => {
    const result = rewriteHlsManifest('#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI="https://cdn.example/steer.json"\nsegment.ts', 'https://origin/a.m3u8', url => `https://manager.test/resource?target=${encodeURIComponent(url)}`);
    expect(result).not.toContain('EXT-X-CONTENT-STEERING');
    expect(result).not.toContain('steer.json');
  });
  it('preserves the DASH resolve-to-zero XLink sentinel without mapping a resource', () => {
    const urls = [];
    const result = rewriteDashManifest('<MPD><Period xlink:href="urn:mpeg:dash:resolve-to-zero:2013" xlink:actuate="onLoad"/><Period xlink:href="next.xml"/></MPD>', 'https://origin/manifest.mpd', url => { urls.push(url); return 'https://manager/resource'; });
    expect(result).toContain('xlink:href="urn:mpeg:dash:resolve-to-zero:2013"');
    expect(urls).toEqual(['https://origin/next.xml']);
    expect(() => rewriteDashManifest('<MPD><Period xlink:href="urn:unrecognized"/></MPD>', 'https://origin/manifest.mpd', url => url)).toThrow('Unsupported manifest resource protocol');
  });
  it('proxies lowercase ClearKey license elements used by DASH clients', () => {
    const urls = [];
    const result = rewriteDashManifest('<MPD><ContentProtection><clearkey:laurl Lic_type="EME-1.0">https://license.example/key?token=provider-secret</clearkey:laurl></ContentProtection></MPD>', 'https://origin/manifest.mpd', (url, options) => { urls.push([url, options]); return 'https://manager/license'; });
    expect(urls).toEqual([['https://license.example/key?token=provider-secret', { template: false, kind: 'license' }]]);
    expect(result).toContain('https://manager/license');
    expect(result).not.toContain('provider-secret');
  });
  it('marks extensionless DASH updates as manifests and maps license URI attributes', () => {
    const urls = [];
    rewriteDashManifest('<MPD><Location>https://cdn.example/update</Location><PatchLocation>patch</PatchLocation><ContentProtection licenseUri="https://license.example/key"/></MPD>', 'https://origin/manifest.mpd', (url, options) => { urls.push([url, options]); return 'https://manager/resource'; });
    expect(urls).toContainEqual(['https://cdn.example/update', { template: false, manifestKind: 'dash' }]);
    expect(urls).toContainEqual(['https://origin/patch', { template: false, manifestKind: 'dash' }]);
    expect(urls).toContainEqual(['https://license.example/key', { template: false, kind: 'license' }]);
  });
  it('fails closed for unsupported external schemes', () => {
    expect(() => rewriteHlsManifest('#EXTM3U\nrtsp://upstream/stream', 'https://origin/a', url => url)).toThrow();
  });
  it('marks extensionless HLS playlist references independently of response MIME', () => {
    const targets = [];
    rewriteHlsManifest('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs?id=1"\n#EXT-X-I-FRAME-STREAM-INF:URI="iframe?id=1"\n#EXT-X-RENDITION-REPORT:URI="rendition?id=1"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n# comment\nchild?id=1\n', 'https://provider.example/master', (url, options) => { targets.push([url, options]); return 'https://manager/resource'; });
    expect(targets).toHaveLength(4);
    for (const [, options] of targets) expect(options).toMatchObject({ manifestKind: 'hls' });
  });
  it('rewrites DASH bitstream switching resources and removes external stylesheets', () => {
    const targets = [];
    const result = rewriteDashManifest('<?xml version="1.0"?><?xml-stylesheet href="https://provider.example/style.xsl?password=secret"?><MPD><SegmentTemplate bitstreamSwitching="https://provider.example/switch-$RepresentationID$.m4s"/></MPD>', 'https://provider.example/master', url => { targets.push(url); return 'https://manager/resource'; });
    expect(targets).toEqual(['https://provider.example/switch-$RepresentationID$.m4s']);
    expect(result).not.toContain('provider.example');
    expect(result).not.toContain('xml-stylesheet');
    expect(result).toContain('<?xml version="1.0"?>');
  });
  it('rejects data-embedded manifests while retaining ordinary inline AES keys', () => {
    const nested = 'data:application/vnd.apple.mpegurl;base64,' + Buffer.from('#EXTM3U\nhttps://provider.example/user/password/seg.ts').toString('base64');
    expect(() => rewriteHlsManifest('#EXTM3U\n' + nested, 'https://origin/master', url => url)).toThrow();
    expect(() => rewriteDashManifest(`<MPD><BaseURL>${nested}</BaseURL></MPD>`, 'https://origin/master', url => url)).toThrow();
    const key = 'data:text/plain;base64,' + Buffer.alloc(16, 7).toString('base64');
    expect(rewriteHlsManifest(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${key}"\nsegment.ts`, 'https://origin/master', () => 'https://manager/resource')).toContain(key);
    expect(() => rewriteHlsManifest(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${nested}"`, 'https://origin/master', url => url)).toThrow();
  });
});
