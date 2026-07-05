import { test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

function escapeHtml(unsafe) {
  if (typeof unsafe !== "string") return "";
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

test('escapeHtml sanitizes script tags', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('browser player keeps auto audio fix scoped per stream', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerJs).toContain("const AUTO_TRANSCODE_KEY = 'player_auto_transcode_streams'");
  expect(playerJs).toContain('function getStreamTranscodeKey(stream)');
  expect(playerJs).toContain('function shouldTranscodeStream(stream)');
  expect(playerJs).toContain('function buildTranscodeUrl(url)');
  expect(playerJs).toContain('rememberAutoTranscode(activeStream)');
  expect(playerJs).not.toContain("localStorage.setItem('transcode_enabled', 'true')");
});

test('browser player treats common TV-only audio codecs as requiring audio fix', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  [
    'ac-3',
    'ec-3',
    'eac3',
    'dts',
    'mp2',
    'mpga',
    'mpeg-layer-2',
    'mp4a.40.34',
  ].forEach((codec) => {
    expect(playerJs).toContain("'" + codec + "'");
  });
});

test('browser player routes Firefox live audio fix through mpegts transcode', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerJs).toContain('const isFirefox =');
  expect(playerJs).toContain('function buildMpegtsTranscodeUrl(url)');
  expect(playerJs).toContain('function shouldUseMpegtsTranscode(url, streamType)');
  expect(playerJs).toContain('function initTranscodedPlayer(url, streamType)');
  expect(playerJs).toContain("streamType === 'live'");
  expect(playerJs).toContain('buildMpegtsTranscodeUrl(url)');
  expect(playerJs).toContain('initMpegtsPlayer(transcodedUrl, streamType)');
});

test('browser player exposes audio and subtitle track selection when tracks exist', () => {
  const playerHtml = fs.readFileSync(path.join(process.cwd(), 'public/player.html'), 'utf8');
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerHtml).toContain('id="audio-track-select"');
  expect(playerHtml).toContain('id="subtitle-track-select"');
  expect(playerJs).toContain('function resetTrackControls()');
  expect(playerJs).toContain('function updateHlsTrackControls()');
  expect(playerJs).toContain('function updateDashTrackControls()');
  expect(playerJs).toContain('function updateNativeTrackControls()');
  expect(playerJs).toContain('Hls.Events.AUDIO_TRACKS_UPDATED');
  expect(playerJs).toContain('Hls.Events.SUBTITLE_TRACKS_UPDATED');
  expect(playerJs).toContain("dashPlayer.getTracksFor('audio')");
  expect(playerJs).toContain("dashPlayer.getTracksFor('text')");
  expect(playerJs).toContain('dashPlayer.setCurrentTrack');
  expect(playerJs).toContain('dashPlayer.setTextTrack');
  expect(playerJs).toContain('video.audioTracks');
  expect(playerJs).toContain('video.textTracks');
  expect(playerJs).toContain('video.onloadedmetadata = updateNativeTrackControls');
});

test('browser player loads server-side VOD tracks when browser exposes none', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerJs).toContain('function loadServerTrackControls(stream, url)');
  expect(playerJs).toContain("withQueryParam(url, 'tracks', 'true')");
  expect(playerJs).toContain('serverTracks.audio');
  expect(playerJs).toContain('serverTracks.subtitles');
  expect(playerJs).toContain("withQueryParam(url, 'audio_track', stream.selected_audio_track)");
  expect(playerJs).not.toContain("withQueryParam(url, 'subtitle_track', stream.selected_subtitle_track)");
  expect(playerJs).toContain('function loadServerSubtitleTrack(url, track)');
  expect(playerJs).toContain("withQueryParam(subtitleUrl, 'subtitle_format', 'vtt')");
  expect(playerJs).toContain("document.createElement('track')");
  expect(playerJs).not.toContain('stream.selected_subtitle_track = subtitleTracks[selected].index;');
});

test('browser player keeps server-side VOD tracks visible after native metadata events', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerJs).toContain('let serverTrackControlsActive = false;');
  expect(playerJs).toContain('serverTrackControlsActive = false;');
  expect(playerJs).toContain('if (serverTrackControlsActive) return;');
  expect(playerJs).toContain('serverTrackControlsActive = audioTracks.length > 1 || subtitleTracks.length > 0;');
});

test('browser player detects DASH streams from URL and channel metadata', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  expect(playerJs).toContain('function isMpdStream(stream, url)');
  expect(playerJs).toContain('stream.container_extension');
  expect(playerJs).toContain('stream.mime_type');
  expect(playerJs).toContain("ext === 'mpd' || ext === 'dash'");
  expect(playerJs).toContain("url.indexOf('/live/mpd/') !== -1");
  expect(playerJs).toContain('if (isMpdStream(stream, url))');
});

test('browser player renders channel lists before background EPG load completes', () => {
  const playerJs = fs.readFileSync(path.join(process.cwd(), 'public/player.js'), 'utf8');

  const renderIndex = playerJs.indexOf('renderView();\n      loadEpgSchedule().then');
  const epgFunctionIndex = playerJs.indexOf('async function loadEpgSchedule()');

  expect(renderIndex).toBeGreaterThan(-1);
  expect(epgFunctionIndex).toBeGreaterThan(renderIndex);
  expect(playerJs).toContain("if (loaded && currentType === 'live')");
});
