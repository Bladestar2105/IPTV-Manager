import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import { performSync } from '../../src/services/syncService.js';
import { encrypt } from '../../src/utils/crypto.js';

// Mock the network calls inside syncService
vi.mock('../../src/utils/network.js', () => ({
  fetchSafe: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ user_info: { exp_date: 'null' } })
  })
}));

// Mock the Xtream client to return a predictable set of channels
vi.mock('@iptv/xtream-api', () => {
  return {
    Xtream: class {
      constructor() {}
      getChannels() {
        return Promise.resolve([
          {
            num: 1,
            name: 'DE RTL',
            stream_type: 'live',
            stream_id: 1234,
            stream_icon: 'logo.png',
            epg_channel_id: 'rtl',
            category_id: '10', // Live category
          }
        ]);
      }
    }
  };
});

describe('Sync Service Functional Tests', () => {
  let userId;
  let providerId;
  let userCategoryId;

  beforeAll(() => {
    // Initialize real SQLite DB in the data directory configured by .env.test (usually /tmp/data)
    initDb(true);

    // Clean up
    db.prepare('DELETE FROM sync_logs').run();
    db.prepare('DELETE FROM stream_stats').run();
    db.prepare('DELETE FROM epg_channel_mappings').run();
    db.prepare('DELETE FROM user_channels').run();
    db.prepare('DELETE FROM category_mappings').run();
    db.prepare('DELETE FROM provider_channels').run();
    db.prepare('DELETE FROM sync_configs').run();
    db.prepare('DELETE FROM user_backups').run();
    db.prepare('DELETE FROM current_streams').run();
    db.prepare('DELETE FROM temporary_tokens').run();
    db.prepare('DELETE FROM shared_links').run();
    db.prepare('DELETE FROM providers').run();
    db.prepare('DELETE FROM user_categories').run();
    db.prepare('DELETE FROM users').run();

    // Create a user
    const userRes = db.prepare("INSERT INTO users (username, password) VALUES ('testuser', 'pass')").run();
    userId = userRes.lastInsertRowid;

    // Create a user category mapped to the live category (ID 10)
    const catRes = db.prepare("INSERT INTO user_categories (user_id, name, type) VALUES (?, 'Live TV', 'live')").run(userId);
    userCategoryId = catRes.lastInsertRowid;

    // Create a provider
    const provRes = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('TestProv', 'http://test.com', 'user', ?, ?)").run(encrypt('pass'), userId);
    providerId = provRes.lastInsertRowid;

    // Create a sync config with auto_add_channels = 1
    db.prepare("INSERT INTO sync_configs (provider_id, user_id, auto_add_channels, auto_add_categories) VALUES (?, ?, 1, 0)").run(providerId, userId);

    // Create the category mapping (Provider category 10 (live) -> User category 'Live TV')
    db.prepare("INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, category_type) VALUES (?, ?, '10', 'Live Category', ?, 'live')").run(providerId, userId, userCategoryId);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should sync the live channel and assign to user category', async () => {
    // 1. Perform first sync. The mock returns a live channel with category 10 and stream_id 1234.
    const result = await performSync(providerId, userId, true);

    expect(result.channelsAdded).toBe(1);

    // Verify channel is in provider_channels
    const pc = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ? AND remote_stream_id = 1234').get(providerId);
    expect(pc).toBeDefined();
    expect(pc.stream_type).toBe('live');
    expect(pc.original_category_id).toBe(10);

    // Verify channel is assigned to user_channels
    const uc = db.prepare('SELECT * FROM user_channels WHERE provider_channel_id = ?').get(pc.id);
    expect(uc).toBeDefined();
    expect(uc.user_category_id).toBe(userCategoryId);
  });

  it('should remove the channel from the user category when it changes stream type (e.g., to movie)', async () => {
    // 2. Now simulate the provider updating the channel. They keep stream_id 1234, but change stream_type to 'movie'.

    // We update the mock inside this test block.
    // We mock fetchSafe to simulate the get_vod_streams endpoint returning our modified channel.
    const networkUtils = await import('../../src/utils/network.js');
    networkUtils.fetchSafe.mockImplementation(async (url) => {
      if (url.includes('action=get_vod_streams')) {
        return {
          ok: true,
          json: () => Promise.resolve([
            {
              num: 1,
              name: 'AR Filmname', // Name changed
              stream_type: 'movie', // Type changed
              stream_id: 1234,      // Same ID
              stream_icon: 'logo.png',
              category_id: '10',    // Same Provider Category ID, but now it's a VOD category.
            }
          ])
        };
      }
      return {
        ok: true,
        json: () => Promise.resolve([]) // Return empty array for everything else (e.g. series, live_streams)
      };
    });

    // The Xtream SDK client needs to return empty for live channels so the VOD is the only thing processed for 1234
    const xtreamApi = await import('@iptv/xtream-api');
    xtreamApi.Xtream.prototype.getChannels = vi.fn().mockResolvedValue([]);

    // Perform second sync
    const result = await performSync(providerId, userId, true);

    expect(result.channelsUpdated).toBe(1); // The channel 1234 should have been updated

    // Verify channel in provider_channels has been updated to movie
    const pc = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ? AND remote_stream_id = 1234').get(providerId);
    expect(pc).toBeDefined();
    expect(pc.stream_type).toBe('movie');
    expect(pc.name).toBe('AR Filmname');

    // Verify channel was REMOVED from the original 'Live TV' user category
    // because its type changed and it no longer matches the mapping '10_live'.
    const uc = db.prepare('SELECT * FROM user_channels WHERE provider_channel_id = ? AND user_category_id = ?').get(pc.id, userCategoryId);
    expect(uc).toBeUndefined(); // Should be undefined (deleted)
  });
});
