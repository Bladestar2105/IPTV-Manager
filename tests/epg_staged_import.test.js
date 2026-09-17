import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
vi.mock('../src/utils/network.js', () => ({ fetchSafe }));
vi.mock('../src/database/db.js', () => ({
  default: { prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) },
  initDb: vi.fn(),
}));
vi.mock('../src/services/logoResolver.js', () => ({ invalidateEpgLogosCache: vi.fn() }));

const { importEpgFromUrl, stagingTableNames, dropOrphanedStagingTables, EPG_STAGE_PREFIX } =
  await import('../src/services/epgImportService.js');
const { initEpgDb } = await import('../src/database/epgDb.js');
const epgDb = (await import('../src/database/epgDb.js')).default;

initEpgDb();

const SOURCE_TYPE = 'custom';
const SOURCE_ID = 9991;

const xml = programmes => `<?xml version="1.0" encoding="UTF-8"?><tv>
  <channel id="ch1"><display-name>Channel One</display-name></channel>
  ${programmes.map(p => `<programme channel="ch1" start="${p.start}" stop="${p.stop}"><title>${p.title}</title></programme>`).join('\n')}
</tv>`;

const future = offsetHours => {
  const d = new Date(Date.now() + offsetHours * 3600000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
};

const liveCounts = () => ({
  channels: epgDb.prepare('SELECT COUNT(*) c FROM epg_channels WHERE source_type = ? AND source_id = ?').get(SOURCE_TYPE, SOURCE_ID).c,
  programs: epgDb.prepare('SELECT COUNT(*) c FROM epg_programs WHERE source_type = ? AND source_id = ?').get(SOURCE_TYPE, SOURCE_ID).c,
});

// Staging table names carry a per-run token, so count anything that is one.
const stagingTableCount = () =>
  epgDb.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE ? || '%'")
    .get(EPG_STAGE_PREFIX).c;

function seedExisting() {
  epgDb.prepare('INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('old-ch', 'Old Channel', '', SOURCE_TYPE, SOURCE_ID, 1);
  epgDb.prepare('INSERT OR IGNORE INTO epg_programs (channel_id, source_type, source_id, start, stop, title, desc, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old-ch', SOURCE_TYPE, SOURCE_ID, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600, 'Old Show', '', '');
}

describe('staged EPG import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    epgDb.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID);
    epgDb.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID);
    dropOrphanedStagingTables(epgDb);
  });

  afterAll(() => {
    epgDb.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID);
    epgDb.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID);
  });

  it('replaces the data of a source on a successful import', async () => {
    seedExisting();
    fetchSafe.mockResolvedValue({
      ok: true,
      body: Readable.from([xml([{ start: future(1), stop: future(2), title: 'New Show' }])]),
    });

    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID)).resolves.toMatchObject({ success: true });

    expect(liveCounts()).toEqual({ channels: 1, programs: 1 });
    expect(epgDb.prepare('SELECT id FROM epg_channels WHERE source_type = ? AND source_id = ?').get(SOURCE_TYPE, SOURCE_ID).id).toBe('ch1');
    expect(stagingTableCount()).toBe(0);
  });

  it('keeps the previous data when the download breaks mid-stream', async () => {
    seedExisting();
    const before = liveCounts();
    expect(before.channels).toBe(1);

    let emitted = false;
    const broken = new Readable({
      read() {
        if (emitted) return;
        emitted = true;
        this.push('<?xml version="1.0"?><tv><channel id="ch1"><display-name>Partial');
        // Asynchronously, so the import has attached its error handler first —
        // exactly how a socket hang up arrives in production.
        setImmediate(() => this.destroy(new Error('socket hang up')));
      },
    });
    fetchSafe.mockResolvedValue({ ok: true, body: broken });

    // Before staging, the old rows were deleted up front and a failure like this
    // left the source without any EPG data at all.
    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID)).rejects.toThrow();

    expect(liveCounts()).toEqual(before);
    expect(epgDb.prepare('SELECT id FROM epg_channels WHERE source_type = ? AND source_id = ?').get(SOURCE_TYPE, SOURCE_ID).id).toBe('old-ch');
    expect(stagingTableCount()).toBe(0);
  });

  it('refuses to trade existing data for an empty feed', async () => {
    seedExisting();
    fetchSafe.mockResolvedValue({ ok: true, body: Readable.from(['<?xml version="1.0"?><tv></tv>']) });

    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID))
      .rejects.toThrow(/no channels or programmes/i);
    expect(liveCounts().channels).toBe(1);
  });

  it('accepts an empty feed when the source has no data yet', async () => {
    fetchSafe.mockResolvedValue({ ok: true, body: Readable.from(['<?xml version="1.0"?><tv></tv>']) });
    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID)).resolves.toMatchObject({ success: true });
    expect(liveCounts()).toEqual({ channels: 0, programs: 0 });
  });

  it('rejects an unusable source identity instead of building a table name from it', () => {
    expect(stagingTableNames('custom"; DROP TABLE epg_channels; --', 1, 'tok').channels)
      .toBe(`${EPG_STAGE_PREFIX}channels_customdroptableepgchannels_1_tok`);
    expect(() => stagingTableNames('custom', '1; DROP TABLE epg_channels')).toThrow(/Invalid EPG source identity/);
    expect(() => stagingTableNames('', 1)).toThrow(/Invalid EPG source identity/);
    // A hostile token cannot inject DDL: only [a-z0-9] survives, and an empty
    // result is rejected.
    const hostile = stagingTableNames('custom', 1, '"; DROP TABLE epg_channels; --');
    expect(hostile.channels).toMatch(/^[a-z0-9_]+$/);
    expect(hostile.programs).toMatch(/^[a-z0-9_]+$/);
    expect(() => stagingTableNames('custom', 1, '!!!')).toThrow(/Invalid EPG source identity/);
  });

  it('gives two runs of the same source separate staging tables', () => {
    // A scheduled provider update and the update fired after a manual sync can
    // overlap; shared names let one run drop the tables the other is filling.
    const a = stagingTableNames(SOURCE_TYPE, SOURCE_ID);
    const b = stagingTableNames(SOURCE_TYPE, SOURCE_ID);
    expect(a.channels).not.toBe(b.channels);
    expect(a.programs).not.toBe(b.programs);
    expect(a.channels.startsWith(`${EPG_STAGE_PREFIX}channels_${SOURCE_TYPE}_${SOURCE_ID}_`)).toBe(true);
  });

  it('sweeps staging tables an aborted run left behind', () => {
    const orphan = stagingTableNames(SOURCE_TYPE, SOURCE_ID);
    epgDb.exec(`CREATE TABLE ${orphan.channels} (id TEXT); CREATE TABLE ${orphan.programs} (id TEXT);`);
    expect(stagingTableCount()).toBe(2);

    expect(dropOrphanedStagingTables(epgDb)).toBe(2);
    expect(stagingTableCount()).toBe(0);
  });
});
