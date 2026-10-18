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
});
