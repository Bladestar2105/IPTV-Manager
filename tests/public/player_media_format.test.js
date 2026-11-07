import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/player.js', import.meta.url), 'utf8');
function player() {
  const strategies = [];
  const context = vm.createContext({
    URL, window: { location: { href: 'http://manager.test/player.html' } }, token: null, castSession: null,
    activeStream: null, retryCount: 0, isRetrying: false, video: { dataset: {} },
    nowPlayingChannel: {}, nowPlayingProgram: {}, transcodeSwitch: {},
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
    updateNowPlayingInfo() {}, hideMpdInfo() {}, setTimeout() {}, destroyAllPlayers() {}, setPlayerStatus() {}, t: key => key,
    shouldTranscodeStream: () => false, isIOS: false, hasNativeHLS: true, mpegts: { isSupported: () => true }, Hls: { isSupported: () => true },
    initDashPlayer: url => strategies.push(['dash', url]), initMpegtsPlayer: url => strategies.push(['mpegts', url]),
    initHlsPlayer: url => strategies.push(['hls', url]), initNativePlayer: url => strategies.push(['native', url]),
    initTranscodedPlayer: url => strategies.push(['transcode', url]), loadServerTrackControls: vi.fn(), console: { log() {}, error() {} },
    chrome: { cast: { media: {
      MediaInfo: class { constructor(url, contentType) { this.url = url; this.contentType = contentType; } },
      GenericMediaMetadata: class {}, LoadRequest: class { constructor(mediaInfo) { this.mediaInfo = mediaInfo; } }
    } } }
  });
  const names = ['getMediaPath', 'getMediaExtension', 'isMpdStream', 'applyServerTrackParams', 'playStream', 'loadRemoteMedia', 'withQueryParam', 'buildTranscodeUrl', 'buildMpegtsTranscodeUrl'];
  vm.runInContext(names.map(name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || '').join('\n'), context);
  return { context, strategies };
}

const formats = [
  ['/movie/viewer/Secure.ts.password/42.mp4', 'native', 'video/mp4'],
  ['/movie/viewer/Secure.m3u8.password/42.mp4', 'native', 'video/mp4'],
  ['/movie/viewer/password/42.mp4?hint=.ts', 'native', 'video/mp4'],
  ['/movie/viewer/password/42.mp4?hint=.m3u8', 'native', 'video/mp4'],
  ['/live/viewer/Secure.mp4.password/42.m3u8', 'hls', 'application/x-mpegurl'],
  ['/live/viewer/password/42.m3u8?hint=.mpd', 'hls', 'application/x-mpegurl'],
  ['/live/viewer/password/42.ts?hint=.mpd', 'mpegts', 'application/x-mpegurl'],
  ['/live/mpd/StrongPassword123/42.ts', 'mpegts', 'application/x-mpegurl'],
  ['/movie/viewer/password/42.mp4?hint=/live/mpd/fake', 'native', 'video/mp4'],
  ['/live/viewer/password/42.M3U8#hint=.ts', 'hls', 'application/x-mpegurl'],
  ['/movie/viewer/password/42.MPD?hint=.ts', 'dash', 'application/dash+xml'],
  ['/live/mpd/viewer/Secure.ts.password/42/manifest.mpd?hint=.mp4', 'dash', 'application/dash+xml']
];

test.each(formats)('playback chooses the media pathname format for %s', (url, strategy) => {
  const p = player();
  p.context.playStream({ url, type: url.startsWith('/movie/') ? 'movie' : 'live', name: 'Channel' });
  expect(p.strategies).toEqual([[strategy, url]]);
  if (url.startsWith('/movie/') && strategy === 'native') expect(p.context.loadServerTrackControls).toHaveBeenCalledOnce();
});

test.each(formats)('Cast chooses the media pathname MIME type for %s', (url, _strategy, mime) => {
  const p = player();
  p.context.castSession = { loadMedia: vi.fn(() => Promise.resolve()) };
  p.context.loadRemoteMedia({ url, name: 'Channel' });
  expect(p.context.castSession.loadMedia.mock.calls[0][0].mediaInfo.contentType).toBe(mime);
});

test.each([
  ['/movie/viewer/Secure.ts.password/42.mp4?hint=.ts', '/movie/viewer/Secure.ts.password/42.mp4?hint=.ts&transcode=true'],
  ['/live/viewer/Secure.ts.password/42.m3u8?hint=.ts', '/live/viewer/Secure.ts.password/42.mp4?hint=.ts&transcode=true']
])('transcoding rewrites only the actual media extension for %s', (url, expected) => {
  expect(player().context.buildTranscodeUrl(url)).toBe(expected);
});

test.each([
  ['/movie/viewer/password/42.mp4?hint=/live/fake.m3u8', '/movie/viewer/password/42.mp4?hint=/live/fake.m3u8&transcode=true'],
  ['/live/viewer/Secure.mp4.password/42.m3u8?hint=.mpd', '/live/viewer/Secure.mp4.password/42.ts?hint=.mpd&transcode=true']
])('MPEG-TS transcoding uses the actual live media path for %s', (url, expected) => {
  expect(player().context.buildMpegtsTranscodeUrl(url)).toBe(expected);
});
