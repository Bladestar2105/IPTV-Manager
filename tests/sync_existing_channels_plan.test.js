import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { EXISTING_CHANNELS_SQL, selectStaleProviderChannels } from '../src/services/syncService.js';

// This read happens inside the catalog write transaction, which is the longest
// write lock the application takes — so its cost is lock time that every other
// worker waits out before reporting "database is locked". An ORDER BY that
// SQLite cannot serve from an index sorts the provider's whole catalog in a
// temp B-tree first: 295,327 rows cost 2489ms with the sort and 1857ms without
// it on the affected deployment.

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE provider_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider_id INTEGER NOT NULL, remote_stream_id INTEGER,
    name TEXT, original_category_id INTEGER, logo TEXT, stream_type TEXT DEFAULT 'live',
    epg_channel_id TEXT, original_sort_order INTEGER, tv_archive INTEGER, tv_archive_duration INTEGER,
    metadata TEXT, mime_type TEXT, rating TEXT, rating_5based REAL, added TEXT, plot TEXT,
    "cast" TEXT, director TEXT, genre TEXT, releaseDate TEXT, youtube_trailer TEXT,
    episode_run_time TEXT, UNIQUE(provider_id, remote_stream_id)
  );
  CREATE UNIQUE INDEX idx_pc_prov_remote ON provider_channels(provider_id, remote_stream_id);
`);
const insert = db.prepare(
  'INSERT INTO provider_channels (provider_id, remote_stream_id, stream_type) VALUES (?, ?, ?)');
db.transaction(() => {
  for (let i = 1; i <= 300; i++) insert.run(1, i, i % 3 === 0 ? 'movie' : 'live');
  for (let i = 1; i <= 50; i++) insert.run(2, i, 'live');
})();

afterAll(() => db.close());

describe('the catalog write transaction read', () => {
  const planOf = sql => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1).map(step => step.detail).join(' | ');

  it('asks SQLite for no sort it would have to build a temp B-tree for', () => {
    expect(planOf(EXISTING_CHANNELS_SQL)).not.toMatch(/TEMP B-TREE/i);
  });

  it('shows what the ordered form cost', () => {
    // The same statement with the clause that was removed. COALESCE hides the
    // column from every index, so SQLite has no choice but to sort.
    expect(planOf(`${EXISTING_CHANNELS_SQL} ORDER BY COALESCE(stream_type, 'live'), id`))
      .toMatch(/TEMP B-TREE/i);
  });

  it('still returns exactly the channels of that provider', () => {
    const rows = db.prepare(EXISTING_CHANNELS_SQL).all(1);

    expect(rows).toHaveLength(300);
    expect(new Set(rows.map(row => row.remote_stream_id)).size).toBe(300);
    expect(rows.every(row => row.name === null || typeof row.name === 'string')).toBe(true);
  });

  it('does not depend on the order it is read in', () => {
    // The three consumers are a Map keyed by remote_stream_id, a per-type
    // count, and this one, whose output is deduplicated into a Set before any
    // row is deleted.
    const rows = db.prepare(EXISTING_CHANNELS_SQL).all(1);
    const seen = new Map([['live', new Set()], ['movie', new Set()]]);
    const types = new Set(['live', 'movie']);

    const forward = selectStaleProviderChannels(rows, seen, types).map(row => row.id).sort((a, b) => a - b);
    const reversed = selectStaleProviderChannels([...rows].reverse(), seen, types)
      .map(row => row.id).sort((a, b) => a - b);

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(300);
  });
});
