import { expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = process.cwd();
const helperPath = path.join(root, 'public/player_mpd_info.js');

function loadHelper() {
  expect(fs.existsSync(helperPath), 'public/player_mpd_info.js exists').toBe(true);
  const source = fs.readFileSync(helperPath, 'utf8');
  const sandbox = { window: {}, console };
  sandbox.self = sandbox.window;
  vm.runInNewContext(source, sandbox, { filename: 'player_mpd_info.js' });
  return sandbox.window.IPTVPlayerMpdInfo;
}

test('MPD info helper parses DASH manifest details', () => {
  const helper = loadHelper();
  const mpd = `<?xml version="1.0"?>
<MPD type="dynamic" minBufferTime="PT2S" mediaPresentationDuration="PT1H2M3S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.640028">
      <Representation id="v1" bandwidth="2500000" width="1280" height="720" />
      <Representation id="v2" bandwidth="5000000" width="1920" height="1080" codecs="hev1.1.6.L120" />
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="de" codecs="mp4a.40.2">
      <Representation id="a1" bandwidth="128000" />
    </AdaptationSet>
  </Period>
</MPD>`;

  const info = helper.parseXml(mpd);

  expect(info).toMatchObject({
    type: 'dynamic',
    duration: '1h 2m 3s',
    minBufferTime: '2s',
    periods: 1,
    adaptationSets: 2,
    representations: 3,
  });
  expect(info.video[0]).toMatchObject({
    resolution: '1280x720',
    codec: 'avc1.640028',
    bandwidth: '2.5 Mbps',
  });
  expect(info.video[1]).toMatchObject({
    resolution: '1920x1080',
    codec: 'hev1.1.6.L120',
    bandwidth: '5 Mbps',
  });
  expect(info.audio[0]).toMatchObject({
    language: 'de',
    codec: 'mp4a.40.2',
    bandwidth: '128 kbps',
  });
});

test('web player wires MPD info panel to DASH playback', () => {
  const html = fs.readFileSync(path.join(root, 'public/player.html'), 'utf8');
  const playerJs = fs.readFileSync(path.join(root, 'public/player.js'), 'utf8');

  expect(html).toContain('player_mpd_info.js');
  expect(html).toContain('id="mpd-info-panel"');
  expect(playerJs).toContain('function showMpdInfoLoading()');
  expect(playerJs).toContain('function renderMpdInfo(info)');
  expect(playerJs).toContain('function hideMpdInfo()');
  expect(playerJs).toContain('dashjs.MediaPlayer.events.MANIFEST_LOADED');
});
