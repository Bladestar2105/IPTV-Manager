
import { parseM3u, parseM3uStream } from '../src/playlist_parser.js';
import assert from 'assert';
import { Readable } from 'stream';

const sampleM3u = `#EXTM3U
#EXTINF:-1 tvg-id="CNN.us" tvg-name="CNN" tvg-logo="http://logo.com/cnn.png" group-title="News",CNN US
http://server.com/cnn.ts
#EXTINF:-1 tvg-id="BBC" group-title="News",BBC World
#EXTVLCOPT:http-user-agent=Mozilla/5.0
http://server.com/bbc.m3u8
#EXTINF:0,Local Channel
http://local.com/stream.mp4
`;

async function test() {
  console.log('Testing parseM3u (Legacy)...');
  const result = parseM3u(sampleM3u);

  assert.strictEqual(result.channels.length, 3);

  const cnn = result.channels[0];
  assert.strictEqual(cnn.name, 'CNN US');
  assert.strictEqual(cnn.epg_id, 'CNN.us');
  assert.strictEqual(cnn.logo, 'http://logo.com/cnn.png');
  assert.strictEqual(cnn.group, 'News');
  assert.strictEqual(cnn.url, 'http://server.com/cnn.ts');

  const bbc = result.channels[1];
  assert.strictEqual(bbc.name, 'BBC World');
  assert.strictEqual(bbc.metadata.http_headers['User-Agent'], 'Mozilla/5.0');

  console.log('Legacy test passed.');

  console.log('Testing parseM3uStream...');

  // Create a stream from the string
  const stream = Readable.from([sampleM3u]);
  const resultStream = await parseM3uStream(stream);

  assert.strictEqual(resultStream.isM3u, true);
  assert.deepStrictEqual(resultStream.channels, result.channels);
  assert.deepStrictEqual(resultStream.categories, result.categories);

  console.log('Stream test passed.');

  console.log('Testing parseM3uStream with invalid header...');
  const invalidM3u = `#EXTINF:0,Test\nhttp://test.com`;
  const streamInvalid = Readable.from([invalidM3u]);
  const resultInvalid = await parseM3uStream(streamInvalid);

  assert.strictEqual(resultInvalid.isM3u, false);
  // It might still parse channels if we allowed it, but strict check is only on isM3u flag return
  assert.strictEqual(resultInvalid.channels.length, 1);

  console.log('Invalid header test passed.');
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
