import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../../src/utils/network.js', async original => ({ ...(await original()), fetchSafe }));
vi.mock('../../src/database/db.js', () => ({ default: mainDb }));
vi.mock('../../src/services/logoResolver.js', () => ({ invalidateEpgLogosCache: vi.fn() }));
const mainDb = new Database(':memory:');
mainDb.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, last_epg_attempt INTEGER);
  CREATE TABLE provider_channels (id INTEGER PRIMARY KEY, provider_id INTEGER, epg_channel_id TEXT,
    name TEXT, logo TEXT, tv_archive INTEGER, tv_archive_duration INTEGER);
  CREATE TABLE epg_channel_mappings (provider_channel_id INTEGER PRIMARY KEY, epg_channel_id TEXT);
`);
const dataDir = mkdtempSync(join(tmpdir(), 'iptv-xmltv-archive-'));
process.env.DATA_DIR = dataDir;
const { default: epgDb, initEpgDb } = await import('../../src/database/epgDb.js');
const { importEpgFromUrl } = await import('../../src/services/epgImportService.js');
initEpgDb();
const now = 1800000000;
const oldStart = now - 13 * 86400;
const date = seconds => new Date(seconds * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const feed = () => `<?xml version="1.0"?><tv><channel id="native-news"><display-name>Native News</display-name></channel>
  <programme channel="native-news" start="${date(oldStart)}" stop="${date(oldStart + 3600)}"><title>Native history</title></programme>
  <programme channel="native-news" start="${date(now - 60)}" stop="${date(now + 3600)}"><title>Native current</title></programme>
  <programme channel="native-news" start="${date(now + 3600)}" stop="${date(now + 7200)}"><title>Native future</title></programme></tv>`;
const importFeed = () => {
  fetchSafe.mockResolvedValue({ ok: true, body: Readable.from([feed()]) });
  return importEpgFromUrl('https://provider.invalid/xmltv.php', 'provider', 1);
};
const seed = (channelId, start, stop, title) => {
  epgDb.prepare(`INSERT OR IGNORE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
    VALUES (?, 'Cached channel', 'cached-logo.png', 'provider', 1, ?)`).run(channelId, now - 3600);
  epgDb.prepare(`INSERT INTO epg_programs (channel_id, source_type, source_id, start, stop, title)
    VALUES (?, 'provider', 1, ?, ?, ?)`).run(channelId, start, stop, title);
};
const programs = () => epgDb.prepare("SELECT channel_id, title FROM epg_programs WHERE source_type = 'provider' AND source_id = 1 ORDER BY channel_id, start").all();
const channel = id => epgDb.prepare("SELECT name, logo FROM epg_channels WHERE source_type = 'provider' AND source_id = 1 AND id = ?").get(id);

describe('provider XMLTV promotion retains currently mapped API history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    mainDb.exec(`DELETE FROM epg_channel_mappings; DELETE FROM provider_channels; DELETE FROM providers;
      INSERT INTO providers VALUES (1, 0);
      INSERT INTO provider_channels VALUES (11, 1, 'native-news', 'News', '', 1, 14);
      INSERT INTO epg_channel_mappings VALUES (11, 'manual-news');`);
    epgDb.exec('DELETE FROM epg_programs; DELETE FROM epg_channels; DELETE FROM epg_import_state;');
  });
  afterAll(() => {
    vi.restoreAllMocks();
    mainDb.close();
    epgDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('preserves completed mapped history and its source channel while replacing current/future rows', async () => {
    seed('manual-news', oldStart, oldStart + 3600, 'Recovered API history');
    seed('manual-news', now - 60, now + 3600, 'Stale mapped current');
    seed('manual-news', now + 3600, now + 7200, 'Stale mapped future');
    seed('removed-channel', now - 7200, now - 3600, 'Orphaned history');

    await importFeed();

    expect(programs()).toEqual([
      { channel_id: 'manual-news', title: 'Recovered API history' },
      { channel_id: 'native-news', title: 'Native history' },
      { channel_id: 'native-news', title: 'Native current' },
      { channel_id: 'native-news', title: 'Native future' },
    ]);
    expect(channel('manual-news')).toEqual({ name: 'Cached channel', logo: 'cached-logo.png' });
    expect(channel('removed-channel')).toBeUndefined();
  });

  it.each(['mapping removed', 'mapping changed', 'provider channel removed'])('drops mapped history after its %s', async scenario => {
    seed('manual-news', oldStart, oldStart + 3600, 'Recovered API history');
    await importFeed();
    expect(channel('manual-news')).toBeDefined();
    if (scenario === 'mapping removed') mainDb.exec('DELETE FROM epg_channel_mappings');
    if (scenario === 'mapping changed') mainDb.exec("UPDATE epg_channel_mappings SET epg_channel_id = 'different-news'");
    if (scenario === 'provider channel removed') mainDb.exec('DELETE FROM provider_channels');

    await importFeed();

    expect(programs().some(row => row.channel_id === 'manual-news')).toBe(false);
    expect(channel('manual-news')).toBeUndefined();
  });

  it('removes expired mapped history and its unused source channel even while the mapping remains current', async () => {
    seed('manual-news', now - 16 * 86400, now - 15 * 86400, 'Expired API history');

    await importFeed();

    expect(programs().some(row => row.channel_id === 'manual-news')).toBe(false);
    expect(channel('manual-news')).toBeUndefined();
  });

  it('still rejects an empty feed without promoting mapped history as a valid snapshot', async () => {
    seed('manual-news', oldStart, oldStart + 3600, 'Recovered API history');
    fetchSafe.mockResolvedValue({ ok: true, body: Readable.from(['<?xml version="1.0"?><tv/>']) });

    await expect(importEpgFromUrl('https://provider.invalid/xmltv.php', 'provider', 1)).rejects.toThrow(/no channels or programmes/);

    expect(programs()).toEqual([{ channel_id: 'manual-news', title: 'Recovered API history' }]);
    expect(channel('manual-news')).toBeDefined();
  });
});
