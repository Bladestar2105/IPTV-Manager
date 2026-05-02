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
