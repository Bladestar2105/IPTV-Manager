import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
vi.mock('../src/database/db.js', () => ({ default: memDb, initDb: vi.fn(), openDbConnection: () => memDb }));
vi.mock('../src/utils/network.js', async importOriginal => ({
  ...(await importOriginal()), fetchSafe: vi.fn() }));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: v => v, encrypt: v => v }));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));

const { deleteAllProviderChannels, deleteProviderChannelCascade, deleteProviderChannelsByIds } =
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

afterAll(() => memDb.close());

describe('deleteAllProviderChannels', () => {
  beforeEach(() => {
    for (const table of ['series_episode_aliases', 'user_channels', 'stream_stats', 'epg_channel_mappings', 'provider_channels', 'providers']) {
      memDb.prepare(`DELETE FROM ${table}`).run();
    }
    memDb.prepare('INSERT INTO providers (id, name) VALUES (1, ?)').run('a');
    memDb.prepare('INSERT INTO providers (id, name) VALUES (2, ?)').run('b');
  });

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

// The catalog transaction removed stale rows one at a time, five compiled
// statements and five executions per row. A VOD catalog that rotates produces
// tens of thousands of stale rows on an ordinary sync, inside the one
// transaction every other worker is blocked on.
describe('deleteProviderChannelsByIds', () => {
  const idsOf = providerId =>
    memDb.prepare('SELECT id FROM provider_channels WHERE provider_id = ? ORDER BY id').all(providerId).map(r => r.id);

  beforeEach(() => {
    for (const table of ['series_episode_aliases', 'user_channels', 'stream_stats', 'epg_channel_mappings', 'provider_channels', 'providers']) {
      memDb.prepare(`DELETE FROM ${table}`).run();
    }
    memDb.prepare('INSERT INTO providers (id, name) VALUES (1, ?)').run('a');
    memDb.prepare('INSERT INTO providers (id, name) VALUES (2, ?)').run('b');
  });

  it('produces the same end state as the per-channel cascade', () => {
    seed(1, 12);
    const perChannel = memDb.transaction(() => {
      for (const id of idsOf(1)) deleteProviderChannelCascade(memDb, 1, id);
    });
    perChannel();
    const afterCascade = counts();

    seed(1, 12);
    const ids = idsOf(1);
    const removed = memDb.transaction(() => deleteProviderChannelsByIds(memDb, 1, ids))();

    expect(removed).toBe(12);
    expect(counts()).toEqual(afterCascade);
  });

  it('removes only the rows it was given', () => {
    seed(1, 10);
    const ids = idsOf(1).slice(0, 4);

    memDb.transaction(() => deleteProviderChannelsByIds(memDb, 1, ids))();

    expect(idsOf(1)).toHaveLength(6);
    expect(counts()).toEqual({ channels: 6, mappings: 6, stats: 6, assignments: 6, aliases: 6 });
  });

  it('takes nothing with an id that belongs to another provider', () => {
    seed(1, 3);
    seed(2, 3);
    const foreign = idsOf(2);

    const removed = memDb.transaction(() => deleteProviderChannelsByIds(memDb, 1, foreign))();

    expect(removed).toBe(0);
    expect(counts()).toEqual({ channels: 6, mappings: 6, stats: 6, assignments: 6, aliases: 6 });
  });

  it('compiles a constant number of statements regardless of how many rows are stale', () => {
    seed(1, 1000);
    const ids = idsOf(1);
    const prepared = [];
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => { prepared.push(sql); return original(sql); });
    try {
      memDb.transaction(() => deleteProviderChannelsByIds(memDb, 1, ids))();
    } finally {
      spy.mockRestore();
    }

    // Three batches — 400, 400, 200 — but only two groups of five statements.
    expect(prepared).toHaveLength(10);
    expect(counts()).toEqual({ channels: 0, mappings: 0, stats: 0, assignments: 0, aliases: 0 });
  });

  it('is a no-op for an empty set', () => {
    seed(1, 2);
    const prepared = [];
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => { prepared.push(sql); return original(sql); });
    try {
      expect(deleteProviderChannelsByIds(memDb, 1, [])).toBe(0);
    } finally {
      spy.mockRestore();
    }

    expect(prepared).toEqual([]);
    expect(counts().channels).toBe(2);
  });

  it('refuses to continue when it removed fewer rows than the provider owns', () => {
    // The per-row cascade threw when a delete did not remove exactly its one
    // row, which rolled the whole synchronization back. A catalog written on a
    // reading of the table that no longer holds is worse than a failed sync.
    seed(1, 3);
    const ids = idsOf(1);
    const original = memDb.prepare.bind(memDb);
    const spy = vi.spyOn(memDb, 'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (!/^\s*DELETE FROM provider_channels/.test(sql)) return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key === 'run') return () => ({ changes: 1 });
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });

    try {
      expect(() => memDb.transaction(() => deleteProviderChannelsByIds(memDb, 1, ids))())
        .toThrow(/removed 1 rows instead of 3/);
    } finally {
      spy.mockRestore();
    }
  });
});
