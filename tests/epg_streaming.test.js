import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadAllEpgChannels } from '../src/services/epgService.js';

describe('EPG Streaming Optimization', () => {
  const testFile = path.resolve('temp_test_epg.xml');
  const testFileMinified = path.resolve('temp_test_epg_minified.xml');

  beforeAll(() => {
    // Create a dummy EPG file with some channels (pretty printed)
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="TestGenerator">
  <channel id="test.channel.1">
    <display-name>Test Channel 1</display-name>
    <icon src="http://example.com/logo1.png" />
  </channel>
  <channel id="test.channel.2">
    <display-name lang="en">Test Channel 2</display-name>
  </channel>
  <channel id="test.channel.3">
    <display-name>Test Channel 3</display-name>
    <icon src="http://example.com/logo3.png" />
  </channel>
  <programme start="20231026000000 +0000" stop="20231026010000 +0000" channel="test.channel.1">
    <title>Test Program</title>
  </programme>
</tv>`;
    fs.writeFileSync(testFile, xmlContent);

    // Create minified EPG file (single line)
    const xmlContentMinified = `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="test.channel.m1"><display-name>Minified 1</display-name></channel><channel id="test.channel.m2"><display-name>Minified 2</display-name><icon src="http://example.com/m2.png" /></channel></tv>`;
    fs.writeFileSync(testFileMinified, xmlContentMinified);
  });

  afterAll(() => {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    if (fs.existsSync(testFileMinified)) {
      fs.unlinkSync(testFileMinified);
    }
  });

  it('should correctly parse pretty-printed channels from EPG file', async () => {
    const channels = await loadAllEpgChannels([{ file: testFile, source: 'Test Source' }]);

    expect(channels).toHaveLength(3);

    expect(channels[0]).toEqual({
      id: 'test.channel.1',
      name: 'Test Channel 1',
      logo: 'http://example.com/logo1.png',
      source: 'Test Source'
    });

    expect(channels[1]).toEqual({
      id: 'test.channel.2',
      name: 'Test Channel 2',
      logo: null, // No icon
      source: 'Test Source'
    });

    expect(channels[2]).toEqual({
      id: 'test.channel.3',
      name: 'Test Channel 3',
      logo: 'http://example.com/logo3.png',
      source: 'Test Source'
    });
  });

  it('should correctly parse minified channels from EPG file', async () => {
    const channels = await loadAllEpgChannels([{ file: testFileMinified, source: 'Test Source' }]);

    expect(channels).toHaveLength(2);

    expect(channels[0]).toEqual({
      id: 'test.channel.m1',
      name: 'Minified 1',
      logo: null,
      source: 'Test Source'
    });

    expect(channels[1]).toEqual({
      id: 'test.channel.m2',
      name: 'Minified 2',
      logo: 'http://example.com/m2.png',
      source: 'Test Source'
    });
  });
});
