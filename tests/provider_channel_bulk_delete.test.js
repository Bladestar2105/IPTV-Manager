import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', async importOriginal => ({
  ...(await importOriginal()), fetchSafe: vi.fn() }));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));

const { deleteAllProviderChannels, deleteProviderChannelCascade } =
  await import('../src/services/syncService.js');

memDb.pragma('foreign_keys = ON');
memDb.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE provider_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL, remote_stream_id INTEGER,
    UNIQUE(provider_id, remote_stream_id)
  );
  CREATE TABLE epg_channel_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_channel_id INTEGER NOT NULL UNIQUE,
    FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id)
  );
  CREATE TABLE stream_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER,
    FOREIGN KEY (channel_id) REFERENCES provider_channels(id)
  );
  CREATE TABLE user_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_category_id INTEGER, provider_channel_id INTEGER
  );
  CREATE TABLE series_episode_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_channel_id INTEGER NOT NULL,
    FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
  );
`);

function seed(providerId, channelCount) {
  const insertChannel = memDb.prepare('INSERT INTO provider_channels (provider_id, remote_stream_id) VALUES (?, ?)');
  const insertMapping = memDb.prepare('INSERT INTO epg_channel_mappings (provider_channel_id) VALUES (?)');
  const insertStats = memDb.prepare('INSERT INTO stream_stats (channel_id) VALUES (?)');
  const insertAssignment = memDb.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (1, ?)');
  const insertAlias = memDb.prepare('INSERT INTO series_episode_aliases (user_channel_id) VALUES (?)');
  memDb.transaction(() => {
    for (let i = 0; i < channelCount; i++) {
      const channelId = insertChannel.run(providerId, i + 1).lastInsertRowid;
      insertMapping.run(channelId);
      insertStats.run(channelId);
      const assignmentId = insertAssignment.run(channelId).lastInsertRowid;
      insertAlias.run(assignmentId);
    }
  })();
}

const counts = () => ({
  channels: memDb.prepare('SELECT COUNT(*) c FROM provider_channels').get().c,
  mappings: memDb.prepare('SELECT COUNT(*) c FROM epg_channel_mappings').get().c,
  stats: memDb.prepare('SELECT COUNT(*) c FROM stream_stats').get().c,
  assignments: memDb.prepare('SELECT COUNT(*) c FROM user_channels').get().c,
  aliases: memDb.prepare('SELECT COUNT(*) c FROM series_episode_aliases').get().c,
});

describe('deleteAllProviderChannels', () => {
  beforeEach(() => {
    for (const table of ['series_episode_aliases', 'user_channels', 'stream_stats', 'epg_channel_mappings', 'provider_channels', 'providers']) {
      memDb.prepare(`DELETE FROM ${table}`).run();
    }
    memDb.prepare('INSERT INTO providers (id, name) VALUES (1, ?)').run('a');
    memDb.prepare('INSERT INTO providers (id, name) VALUES (2, ?)').run('b');
  });

  afterAll(() => memDb.close());

  it('removes the provider channels and every dependant row', () => {
    seed(1, 25);
    const removed = memDb.transaction(() => deleteAllProviderChannels(memDb, 1))();
    expect(removed).toBe(25);
    expect(counts()).toEqual({ channels: 0, mappings: 0, stats: 0, assignments: 0, aliases: 0 });
  });

  it('leaves other providers untouched', () => {
    seed(1, 10);
    seed(2, 7);
    memDb.transaction(() => deleteAllProviderChannels(memDb, 1))();
    expect(counts()).toEqual({ channels: 7, mappings: 7, stats: 7, assignments: 7, aliases: 7 });
    expect(memDb.prepare('SELECT COUNT(*) c FROM provider_channels WHERE provider_id = 2').get().c).toBe(7);
  });

  it('produces the same end state as the per-channel cascade', () => {
    seed(1, 12);
    const perChannel = memDb.transaction(() => {
      for (const row of memDb.prepare('SELECT id FROM provider_channels WHERE provider_id = ? ORDER BY id').all(1)) {
        deleteProviderChannelCascade(memDb, 1, row.id);
      }
    });
    perChannel();
    const afterCascade = counts();

    seed(1, 12);
    memDb.transaction(() => deleteAllProviderChannels(memDb, 1))();
    expect(counts()).toEqual(afterCascade);
  });

  it('uses a constant number of statements regardless of catalog size', () => {
    seed(1, 200);
    const prepared = [];
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      prepared.push(sql);
      return original(sql);
    });
    try {
      memDb.transaction(() => deleteAllProviderChannels(memDb, 1))();
    } finally {
      spy.mockRestore();
    }
    // Four statements in total, not four per channel.
    expect(prepared).toHaveLength(4);
    expect(counts().channels).toBe(0);
  });
});
