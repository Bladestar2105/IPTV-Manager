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
  it.each([
    '<Metrics><Reporting schemeIdUri="urn:dvb:dash:reporting:2014" dvb:reportingUrl="https://provider.example/report?password=secret" dvb:probability="1000"/></Metrics>',
    '<EventStream schemeIdUri="urn:mpeg:dash:event:callback:2015" value="1"><Event>https://provider.example/callback?token=secret</Event></EventStream>',
    '<EventStream schemeIdUri="urn:mpeg:dash:event:callback:2015" value="1"><Event messageData="https://provider.example/callback?token=secret"/></EventStream>',
    '<InbandEventStream schemeIdUri="urn:mpeg:dash:event:callback:2015" value="1"/>',
  ])('removes automatic DASH telemetry and callback declarations: %s', extension => {
    const result = rewriteDashManifest(`<MPD><Period>${extension}<EventStream schemeIdUri="urn:scte:scte35:2013:xml"><Event>cue</Event></EventStream><SegmentTemplate media="segment.m4s"/></Period></MPD>`, 'https://provider.example/master.mpd', () => 'https://manager/resource');
    expect(result).not.toMatch(/provider\.example|secret|callback:2015|Metrics|Reporting/);
    expect(result).toContain('urn:scte:scte35:2013:xml');
    expect(result).toContain('https://manager/resource');
  });
  it.each([
    ['2014', 'UrlQueryInfo'], ['2016', 'ExtUrlQueryInfo'],
  ])('removes optional DASH URL query extensions and rejects required ones (%s)', (year, element) => {
    const property = `<SupplementalProperty schemeIdUri="urn:mpeg:dash:urlparam:${year}"><up:${element} queryTemplate="$querypart$" queryString="username=upuser&amp;password=secret"/></SupplementalProperty>`;
    const result = rewriteDashManifest(`<MPD>${property}<SegmentTemplate media="segment.m4s"/></MPD>`, 'https://provider.example/master', () => 'https://manager/resource');
    expect(result).not.toMatch(/urlparam|QueryInfo|upuser|secret/);
    expect(result).toContain('https://manager/resource');
    expect(() => rewriteDashManifest(`<MPD>${property.replaceAll('SupplementalProperty', 'EssentialProperty')}</MPD>`, 'https://provider.example/master', url => url)).toThrow('Unsupported required DASH URL query extension');
    expect(() => rewriteDashManifest(`<MPD><up:${element} queryString="password=secret"/></MPD>`, 'https://provider.example/master', url => url)).toThrow('Unsupported DASH URL query extension');
  });
  it.each(['SupplementalProperty', 'EssentialProperty'])('proxies DVB font dependencies in %s', property => {
    const urls = [];
    const result = rewriteDashManifest(`<MPD><${property} schemeIdUri="urn:dvb:dash:fontdownload:2014" value="1" dvb:url="https://provider.example/font.woff?token=secret" dvb:fontFamily="Font" dvb:mimeType="application/font-woff"/></MPD>`, 'https://provider.example/master', url => { urls.push(url); return 'https://manager/resource'; });
    expect(urls).toEqual(['https://provider.example/font.woff?token=secret']);
    expect(result).not.toMatch(/provider\.example|secret/);
    expect(result).toContain('dvb:url="https://manager/resource"');
  });
  it('omits TTML tracks with inherited URLs/templates while retaining audio, video and WebVTT', () => {
    const result = rewriteDashManifest('<MPD><BaseURL>https://provider.example/</BaseURL><Period><SegmentTemplate media="$Number$.mp4"/><AdaptationSet mimeType="application/ttml+xml"><Representation id="unsafe-ttml"/></AdaptationSet><AdaptationSet><Representation id="unsafe-codec" codecs="ttml"/></AdaptationSet><AdaptationSet><Representation id="video" codecs="avc1.4d401f"/></AdaptationSet><AdaptationSet><Representation id="audio" codecs="mp4a.40.2"/></AdaptationSet><AdaptationSet mimeType="text/vtt"><Representation id="webvtt"/></AdaptationSet></Period></MPD>', 'https://provider.example/master', () => 'https://manager/resource');
    expect(result).not.toMatch(/unsafe|ttml|<AdaptationSet><\/AdaptationSet>/);
    for (const id of ['video', 'audio', 'webvtt']) expect(result).toContain(`id="${id}"`);
  });
  it.each(['AdaptationSet', 'Representation', 'SubRepresentation'])('omits unsafe TTML declarations on %s', element => {
    for (const attributes of ['codecs="stpp.ttml.im1t"', 'codecs="&#115;tpp"', 'codecs="application/mp4;codecs=stpp"', 'mimeType="application/ttml+xml"']) {
      expect(rewriteDashManifest(`<MPD><${element} ${attributes}/></MPD>`, 'https://provider.example/master', url => url)).toBe('<MPD></MPD>');
    }
    expect(() => rewriteDashManifest('<MPD codecs="stpp"/>', 'https://provider.example/master', url => url)).toThrow('Unsupported DASH TTML declaration');
  });
  it('rejects HLS variants declaring fragmented TTML codecs', () => {
    expect(() => rewriteHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4d401f,stpp.ttml.im1t"\nchild.m3u8', 'https://provider.example/master', url => url)).toThrow('Unsupported HLS TTML');
  });
  it('proxies decoded HTTP UTC fallback URLs individually while retaining direct timestamps', () => {
    const urls = [];
    const result = rewriteDashManifest('<MPD><UTCTiming schemeIdUri="urn:mpeg:dash:utc:http-iso:2014" value="https&#58;//provider.example/time?token=secret ../fallback"/><UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="2026-10-18T00:00:00Z"/><UTCTiming schemeIdUri="urn:mpeg:dash:utc:ntp:2014" value="provider.example"/></MPD>', 'https://provider.example/live/master', url => { urls.push(url); return `https://manager/time${urls.length}`; });
    expect(urls).toEqual(['https://provider.example/time?token=secret', 'https://provider.example/fallback']);
    expect(result).toContain('value="https://manager/time1 https://manager/time2"');
    expect(result).toContain('2026-10-18T00:00:00Z');
    expect(result).not.toMatch(/provider\.example|secret|ntp:2014/);
  });
});
