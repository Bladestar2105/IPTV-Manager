
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// 1. Mock Modules (Hoisted)
vi.mock('../src/database/db.js', () => {
    return {
        default: {
            prepare: vi.fn(),
            transaction: vi.fn((fn) => {
                return (...args) => fn(...args);
            }),
        }
    };
});

vi.mock('node-fetch', () => {
    return {
        default: vi.fn()
    };
});

vi.mock('@iptv/xtream-api', () => ({
    Xtream: class {
        constructor() {}
        getChannels() { return Promise.resolve([]); }
    }
}));

// 2. Import Modules
import { performSync } from '../src/services/syncService.js';
import db from '../src/database/db.js';
import fetch from 'node-fetch';

describe('performSync Optimization', () => {
  let mockUpdateRun;
  let mockInsertRun;
  let existingChannels = [];

  beforeEach(() => {
    vi.clearAllMocks();
    existingChannels = [];

    mockUpdateRun = vi.fn().mockReturnValue({ changes: 1 });
    mockInsertRun = vi.fn().mockReturnValue({ lastInsertRowid: 123 });

    // Explicitly set transaction implementation
    db.transaction = vi.fn((fn) => {
        return (...args) => fn(...args);
    });

    db.prepare.mockImplementation((sql) => {
      const sqlStr = sql.trim().toUpperCase();

      if (sqlStr.includes('SELECT * FROM SYNC_CONFIGS')) {
        return { get: () => ({ id: 1, sync_interval: 'daily', auto_add_channels: 1, auto_add_categories: 1 }) };
      }
      if (sqlStr.includes('SELECT * FROM PROVIDERS')) {
        return { get: () => ({ id: 1, name: 'Test', url: 'http://test.com/m3u', username: '', password: '' }) };
      }
      if (sqlStr.includes('SELECT * FROM CATEGORY_MAPPINGS')) {
        return { all: () => [] };
      }
      // Relaxed check for existing channels query (fetching all columns)
      if (sqlStr.includes('FROM PROVIDER_CHANNELS') && sqlStr.startsWith('SELECT')) {
        return { all: () => existingChannels };
      }
      if (sqlStr.startsWith('SELECT')) {
          if (sqlStr.includes('COALESCE')) return { get: () => ({ max_sort: 0 }) };
          return { get: () => null, all: () => [] };
      }

      if (sqlStr.includes('UPDATE PROVIDER_CHANNELS')) {
          return { run: mockUpdateRun };
      }
      if (sqlStr.includes('INSERT OR IGNORE INTO PROVIDER_CHANNELS')) {
          return { run: mockInsertRun };
      }

      return { run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) };
    });

    const m3uContent = `#EXTM3U
#EXTINF:-1 tvg-id="Test1" tvg-name="Test Channel 1" tvg-logo="http://logo.png" group-title="Test Group",Test Channel 1
http://stream.url/1.ts
`;
    // Use mockImplementation to return FRESH stream every time
    fetch.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(m3uContent),
      headers: { get: () => 'text/plain' },
      body: Readable.from([m3uContent])
    }));
  });

  it('Optimization Verification: Should NOT call updateChannel if data is identical', async () => {
    // 1. First Run
    await performSync(1, 1, true);

    expect(mockInsertRun).toHaveBeenCalled();
    const args = mockInsertRun.mock.calls[0];

    // 2. Second Run setup
    // We must provide ALL columns that are checked for changes.
    // Use the arguments from the insert call to populate existingChannels ensuring exact match.
    existingChannels = [{
        id: 999,
        // Map arguments to columns based on insertChannel query order
        provider_id: args[0],
        remote_stream_id: args[1],
        name: args[2],
        original_category_id: args[3],
        logo: args[4],
        stream_type: args[5],
        epg_channel_id: args[6],
        original_sort_order: args[7],
        tv_archive: args[8],
        tv_archive_duration: args[9],
        metadata: args[10],
        mime_type: args[11],
        rating: args[12],
        rating_5based: args[13],
        added: args[14],
        plot: args[15],
        cast: args[16],
        director: args[17],
        genre: args[18],
        releaseDate: args[19],
        youtube_trailer: args[20],
        episode_run_time: args[21]
    }];

    mockInsertRun.mockClear();
    mockUpdateRun.mockClear();

    // 3. Second Run execution with Identical Data
    const result = await performSync(1, 1, true);

    // Check behavior (Optimized)
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockInsertRun).not.toHaveBeenCalled(); // Should not insert if existing
    expect(result.channelsUpdated).toBe(0);
    expect(result.channelsAdded).toBe(0);
  });
});
