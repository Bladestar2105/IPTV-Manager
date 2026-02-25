import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import path from 'path';
import { Readable } from 'stream';

// Mock constants BEFORE imports
vi.mock('../src/config/constants.js', async () => {
  const path = await import('path');
  const fs = await import('fs');
  const dir = path.resolve('temp_test_epg_data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return {
    DATA_DIR: dir,
    EPG_DB_PATH: path.resolve('temp_test_epg_data/epg.db')
  };
});

// Mock network
vi.mock('../src/utils/network.js', () => ({
  fetchSafe: vi.fn(),
  httpAgent: {},
  httpsAgent: {}
}));

import { initDb } from '../src/database/db.js';
import { initEpgDb, default as epgDb } from '../src/database/epgDb.js';
import { loadAllEpgChannels, importEpgFromUrl } from '../src/services/epgService.js';
import { fetchSafe } from '../src/utils/network.js';

describe('EPG Streaming Optimization', () => {
  beforeAll(() => {
    initDb(true);
    initEpgDb();
  });

  beforeEach(() => {
    // Clear DB
    epgDb.prepare('DELETE FROM epg_channels').run();
    epgDb.prepare('DELETE FROM epg_programs').run();
    vi.clearAllMocks();
  });

  it('should correctly parse pretty-printed channels from EPG stream', async () => {
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

    // Mock response stream
    const stream = Readable.from([xmlContent]);
    fetchSafe.mockResolvedValue({
        ok: true,
        body: stream
    });

    await importEpgFromUrl('http://mock.url/epg.xml', 'custom', 1);

    const channels = await loadAllEpgChannels();

    expect(channels).toHaveLength(3);
    // Sort by ID to ensure order for assertion (loadAllEpgChannels sorts by name, which is Test Channel 1, 2, 3)
    // Actually loadAllEpgChannels sorts by name ASC.

    expect(channels[0]).toMatchObject({
      id: 'test.channel.1',
      name: 'Test Channel 1',
      logo: 'http://example.com/logo1.png',
      source_type: 'custom'
    });

    expect(channels[1]).toMatchObject({
      id: 'test.channel.2',
      name: 'Test Channel 2',
      logo: null,
      source_type: 'custom'
    });

    expect(channels[2]).toMatchObject({
      id: 'test.channel.3',
      name: 'Test Channel 3',
      logo: 'http://example.com/logo3.png',
      source_type: 'custom'
    });
  });

  it('should correctly parse minified channels from EPG stream', async () => {
    const xmlContentMinified = `<?xml version="1.0" encoding="UTF-8"?><tv><channel id="test.channel.m1"><display-name>Minified 1</display-name></channel><channel id="test.channel.m2"><display-name>Minified 2</display-name><icon src="http://example.com/m2.png" /></channel></tv>`;

    // Mock response stream
    const stream = Readable.from([xmlContentMinified]);
    fetchSafe.mockResolvedValue({
        ok: true,
        body: stream
    });

    await importEpgFromUrl('http://mock.url/minified.xml', 'custom', 2);

    const channels = await loadAllEpgChannels();

    expect(channels).toHaveLength(2);

    expect(channels[0]).toMatchObject({
      id: 'test.channel.m1',
      name: 'Minified 1',
      logo: null,
      source_type: 'custom'
    });

    expect(channels[1]).toMatchObject({
      id: 'test.channel.m2',
      name: 'Minified 2',
      logo: 'http://example.com/m2.png',
      source_type: 'custom'
    });
  });
});
