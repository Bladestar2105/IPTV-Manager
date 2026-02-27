
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';

// Mock constants
vi.mock('../../src/config/constants.js', async () => {
  const path = await import('path');
  return {
    DATA_DIR: path.resolve('temp_bench_epg'),
    EPG_DB_PATH: path.resolve('temp_bench_epg/epg.db')
  };
});

// Mock network
vi.mock('../../src/utils/network.js', () => ({
  fetchSafe: vi.fn(),
  httpAgent: {},
  httpsAgent: {}
}));

// Mock better-sqlite3 - Use a class for the default export to support 'new Database()'
vi.mock('better-sqlite3', () => {
  return {
    default: class Database {
      constructor() {
        this.pragma = vi.fn();
        this.prepare = vi.fn().mockReturnValue({
          run: vi.fn(),
          all: vi.fn().mockReturnValue([]),
          get: vi.fn(),
          iterate: vi.fn().mockReturnValue([]),
        });
        this.transaction = vi.fn().mockImplementation((fn) => fn);
        this.close = vi.fn();
      }
    }
  };
});

// Mock the DB instances
vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn().mockImplementation(() => ({
      run: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      get: vi.fn(),
    })),
  },
  initDb: vi.fn()
}));

vi.mock('../../src/database/epgDb.js', () => ({
  default: {
    prepare: vi.fn().mockImplementation(() => ({
      run: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      get: vi.fn(),
    })),
  },
  initEpgDb: vi.fn()
}));

import { importEpgFromUrl } from '../../src/services/epgService.js';
import { fetchSafe } from '../../src/utils/network.js';

function generateLargeXml(channelCount, programsPerChannel) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Benchmark">\n';

    // Generate channels
    for (let i = 0; i < channelCount; i++) {
        xml += `  <channel id="ch.${i}">
    <display-name>Channel ${i}</display-name>
    <icon src="http://example.com/logo${i}.png" />
  </channel>\n`;
    }

    // Generate programs
    const now = Date.now();
    for (let i = 0; i < channelCount; i++) {
        for (let j = 0; j < programsPerChannel; j++) {
            const start = new Date(now + j * 3600000).toISOString().replace(/[-:T.]/g, '').slice(0, 14) + " +0000";
            const stop = new Date(now + (j + 1) * 3600000).toISOString().replace(/[-:T.]/g, '').slice(0, 14) + " +0000";
            xml += `  <programme start="${start}" stop="${stop}" channel="ch.${i}">
    <title>Program ${j} on Channel ${i}</title>
    <desc>Description for program ${j}...</desc>
  </programme>\n`;
        }
    }

    xml += '</tv>';
    return xml;
}

describe('EPG Import Performance Benchmark', () => {

    it('should measure parsing performance', async () => {
        const channelCount = 5000;
        const programsPerChannel = 5;
        console.log(`Generating XML with ${channelCount} channels and ${programsPerChannel * channelCount} programs...`);
        const xmlContent = generateLargeXml(channelCount, programsPerChannel);
        const sizeMb = xmlContent.length / 1024 / 1024;
        console.log(`XML Size: ${sizeMb.toFixed(2)} MB`);

        // Mock response stream
        const stream = Readable.from([xmlContent]);
        fetchSafe.mockResolvedValue({
            ok: true,
            body: stream
        });

        const start = performance.now();
        await importEpgFromUrl('http://bench.url/epg.xml', 'custom', 999);
        const end = performance.now();

        console.log(`\n---------------------------------------------------`);
        console.log(`EPG Import Time: ${(end - start).toFixed(2)} ms`);
        console.log(`Throughput: ${(sizeMb / ((end - start) / 1000)).toFixed(2)} MB/s`);
        console.log(`---------------------------------------------------\n`);
    }, 60000); // 60s timeout
});
