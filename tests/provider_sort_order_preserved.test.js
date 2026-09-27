import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';

// The order a provider lists its channels in is the order the user sees. It is
// stored per channel in original_sort_order and every display and import query
// sorts by it. This pins that the sync writes it, keeps it, and follows the
// provider when the upstream order changes — independently of the order the
// change-detection snapshot happens to be read in.

const { dataDir, fetchCatalog } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { dataDir: mkdtempSync(join(tmpdir(), 'iptv-sort-order-')), fetchCatalog: vi.fn() };
});
vi.mock('../src/config/constants.js', async o => ({ ...(await o()), DATA_DIR: dataDir }));
vi.mock('../src/services/providerCatalogSyncService.js', async o => ({
  ...(await o()), fetchProviderCatalog: fetchCatalog,
}));
vi.mock('../src/utils/network.js', async o => ({
  ...(await o()), fetchSafe: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));
vi.mock('../src/services/logoResolver.js', () => ({ prePopulateProviderIconCache: vi.fn() }));
vi.mock('../src/services/epgService.js', () => ({ updateProviderEpg: vi.fn(async () => {}) }));
vi.mock('../src/services/seriesSyncService.js', () => ({ syncSeriesEpisodes: vi.fn(async () => ({})) }));
vi.mock('../src/services/ai/syncHistory.js', () => ({
  captureSyncSnapshot: () => null, recordSyncSnapshot: () => [], scheduleSyncFollowups: () => {},
}));

const { default: db, initDb } = await import('../src/database/db.js');
const { performSync } = await import('../src/services/syncService.js');
const { encrypt } = await import('../src/utils/crypto.js');

// Deliberately neither alphabetical nor ascending by remote id, so a fallback
// to name or rowid order would be visible.
const PROVIDER_ORDER = [
  { stream_id: 900, name: 'Zeta' },
  { stream_id: 120, name: 'Alpha' },
  { stream_id: 700, name: 'Mike' },
  { stream_id: 310, name: 'Bravo' },
];

const catalog = channels => ({
  allChannels: channels.map(c => ({ ...c, category_id: 10, stream_type: 'live' })),
  allCategories: [{ category_id: 10, category_name: 'Live' }],
  completeStreamTypes: new Set(['live']),
  snapshotStates: new Map([['live', { count: channels.length }]]),
  failures: [],
});

/** What the catalog and playlist queries return: the provider's own order. */
const asDisplayed = () => db.prepare(`
  SELECT remote_stream_id FROM provider_channels
  WHERE provider_id = 7 ORDER BY original_sort_order ASC, name ASC
`).all().map(row => row.remote_stream_id);

beforeAll(() => { initDb(true); });
afterAll(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }); });

beforeEach(() => {
  for (const t of ['sync_logs', 'user_channels', 'provider_channels', 'provider_sync_state',
    'category_mappings', 'user_categories', 'sync_configs', 'provider_locks', 'providers', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.exec(`
    INSERT INTO users (id, username, password) VALUES (1, 'target', 'test');
    INSERT INTO providers (id, name, url, username, password, user_id)
      VALUES (7, 'provider', 'http://panel.example', 'account', 'test', 1);
    INSERT INTO sync_configs (id, provider_id, user_id, enabled, sync_interval, auto_add_channels,
      auto_add_categories, sync_series_episodes, last_sync, next_sync, granted_by_admin)
      VALUES (1, 7, 1, 1, 'daily', 1, 1, 0, 0, 0, 0);
  `);
  db.prepare('UPDATE providers SET password = ? WHERE id = 7').run(encrypt('secret'));
  fetchCatalog.mockResolvedValue(catalog(PROVIDER_ORDER));
});

describe('the order the provider lists its channels in', () => {
  it('is stored as the provider sent it, not alphabetically or by id', async () => {
    expect((await performSync(7, 1, { mode: 'scheduled' })).status).toBe('success');

    expect(asDisplayed()).toEqual([900, 120, 700, 310]);
    expect(db.prepare(
      'SELECT remote_stream_id, original_sort_order FROM provider_channels WHERE provider_id = 7 ORDER BY original_sort_order'
    ).all()).toEqual([
      { remote_stream_id: 900, original_sort_order: 0 },
      { remote_stream_id: 120, original_sort_order: 1 },
      { remote_stream_id: 700, original_sort_order: 2 },
      { remote_stream_id: 310, original_sort_order: 3 },
    ]);
  });

  it('follows the provider when it reorders its catalog', async () => {
    await performSync(7, 1, { mode: 'scheduled' });
    expect(asDisplayed()).toEqual([900, 120, 700, 310]);

    const reordered = [PROVIDER_ORDER[3], PROVIDER_ORDER[0], PROVIDER_ORDER[2], PROVIDER_ORDER[1]];
    fetchCatalog.mockResolvedValue(catalog(reordered));

    expect((await performSync(7, 1, { mode: 'scheduled' })).status).toBe('success');

    expect(asDisplayed()).toEqual([310, 900, 700, 120]);
  });

  it('survives a run that changes nothing else', async () => {
    await performSync(7, 1, { mode: 'scheduled' });
    const before = asDisplayed();

    await performSync(7, 1, { mode: 'scheduled' });

    expect(asDisplayed()).toEqual(before);
  });
});
