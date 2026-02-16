import { describe, it, expect } from 'vitest';
import { parseM3u, parseM3uStream } from '../src/utils/playlistParser.js';
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

describe('Playlist Parser', () => {
  it('should parse M3U string correctly (Legacy)', () => {
    const result = parseM3u(sampleM3u);

    expect(result.channels.length).toBe(3);

    const cnn = result.channels[0];
    expect(cnn.name).toBe('CNN US');
    expect(cnn.epg_id).toBe('CNN.us');
    expect(cnn.logo).toBe('http://logo.com/cnn.png');
    expect(cnn.group).toBe('News');
    expect(cnn.url).toBe('http://server.com/cnn.ts');

    const bbc = result.channels[1];
    expect(bbc.name).toBe('BBC World');
    expect(bbc.metadata.http_headers['User-Agent']).toBe('Mozilla/5.0');
  });

  it('should parse M3U stream correctly', async () => {
    const stream = Readable.from([sampleM3u]);
    const resultStream = await parseM3uStream(stream);

    // Get expected result from legacy parser
    const result = parseM3u(sampleM3u);

    expect(resultStream.isM3u).toBe(true);
    expect(resultStream.channels).toEqual(result.channels);
    expect(resultStream.categories).toEqual(result.categories);
  });

  it('should handle invalid M3U header in stream', async () => {
    const invalidM3u = `#EXTINF:0,Test\nhttp://test.com`;
    const streamInvalid = Readable.from([invalidM3u]);
    const resultInvalid = await parseM3uStream(streamInvalid);

    expect(resultInvalid.isM3u).toBe(false);
    expect(resultInvalid.channels.length).toBe(1);
  });
});
