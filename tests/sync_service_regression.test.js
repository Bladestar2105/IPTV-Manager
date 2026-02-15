import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');

// Mock dependencies before importing the module under test
vi.doMock('../src/database/db.js', () => ({
  default: memDb,
  initDb: () => {}
}));

vi.mock('node-fetch', () => ({
  default: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
      headers: { get: () => 'application/json' }
  })
}));

vi.mock('@iptv/xtream-api', () => ({
  Xtream: class {
      constructor() {}
      getChannels() { return Promise.resolve([]); }
  }
}));

vi.mock('../src/utils/crypto.js', () => ({
  decrypt: (val) => val,
  encrypt: (val) => val
}));

vi.mock('../src/utils/helpers.js', () => ({
    isAdultCategory: () => false
}));

// Also need to mock playlist_parser since it's imported
vi.mock('../src/playlist_parser.js', () => ({
    parseM3uStream: () => ({ isM3u: false })
}));

describe('Sync Service Regression', () => {
  let performSync;

  beforeAll(async () => {
    // Import the service dynamically so doMock applies
    const service = await import('../src/services/syncService.js');
    performSync = service.performSync;

    // Setup minimal schema for performSync
    memDb.exec(`
      CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT, url TEXT, username TEXT, password TEXT, expiry_date INTEGER);
      CREATE TABLE sync_configs (id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, sync_interval TEXT, auto_add_channels INTEGER, auto_add_categories INTEGER, last_sync INTEGER, next_sync INTEGER);
      CREATE TABLE provider_channels (
          id INTEGER PRIMARY KEY,
          provider_id INTEGER,
          remote_stream_id INTEGER,
          name TEXT,
          original_category_id INTEGER,
          logo TEXT,
          stream_type TEXT,
          epg_channel_id TEXT,
          original_sort_order INTEGER,
          tv_archive INTEGER,
          tv_archive_duration INTEGER,
          metadata TEXT,
          mime_type TEXT,
          rating TEXT,
          rating_5based REAL,
          added TEXT,
          plot TEXT,
          "cast" TEXT,
          director TEXT,
          genre TEXT,
          releaseDate TEXT,
          youtube_trailer TEXT,
          episode_run_time TEXT,
          UNIQUE(provider_id, remote_stream_id)
      );
      CREATE TABLE sync_logs (id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, sync_time INTEGER, status TEXT, channels_added INTEGER, channels_updated INTEGER, categories_added INTEGER, error_message TEXT);
      CREATE TABLE category_mappings (id INTEGER PRIMARY KEY, provider_id INTEGER, user_id INTEGER, provider_category_id INTEGER, provider_category_name TEXT, user_category_id INTEGER, auto_created INTEGER, category_type TEXT);
      CREATE TABLE user_channels (id INTEGER PRIMARY KEY, user_category_id INTEGER, provider_channel_id INTEGER, sort_order INTEGER);
      CREATE TABLE user_categories (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, is_adult INTEGER, sort_order INTEGER, type TEXT);
    `);

    // Insert dummy data
    memDb.prepare("INSERT INTO providers (id, name, url, username, password) VALUES (1, 'Test', 'http://test.com', 'u', 'p')").run();
    memDb.prepare("INSERT INTO sync_configs (provider_id, user_id, sync_interval, auto_add_channels, auto_add_categories) VALUES (1, 1, 'daily', 1, 1)").run();
  });

  afterAll(() => {
      memDb.close();
  });

  it('should not throw syntax error on existingChannels query', async () => {
    const result = await performSync(1, 1);

    if (result.errorMessage) {
        if (result.errorMessage.includes('syntax error')) {
            throw new Error(result.errorMessage);
        }
    }

    const log = memDb.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1').get();
    if (log && log.status === 'error') {
         if (log.error_message && log.error_message.includes('syntax error')) {
            throw new Error(log.error_message);
        }
    }
  });
});
