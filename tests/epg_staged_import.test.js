import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const { fetchSafe } = vi.hoisted(() => ({ fetchSafe: vi.fn() }));
// Keep the real module's other exports: epgImportService derives its staging
// stale floor from resolveMaxRequestDurationMs.
vi.mock('../src/utils/network.js', async importOriginal => ({
  ...(await importOriginal()),
  fetchSafe,
}));
vi.mock('../src/database/db.js', () => ({
  default: { prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }) },
  initDb: vi.fn(),
}));
vi.mock('../src/services/logoResolver.js', () => ({ invalidateEpgLogosCache: vi.fn() }));

const {
  importEpgFromUrl, stagingTableNames, dropOrphanedStagingTables, stagingTableStartedAt,
  resolveStageStaleMs, EPG_STAGE_PREFIX,
} = await import('../src/services/epgImportService.js');
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
    epgDb.prepare('DELETE FROM epg_import_state WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID);
    dropOrphanedStagingTables(epgDb, { staleMs: 1, now: Date.now() + 86400000 });
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

  it('keeps the stale threshold above the maximum request duration', () => {
    // A live import of another process can legitimately hold a body open for
    // the whole request budget, so the sweep threshold cannot be configured
    // below it.
    const previous = process.env.HTTP_MAX_REQUEST_MS;
    const previousStale = process.env.EPG_STAGE_STALE_MS;
    try {
      process.env.HTTP_MAX_REQUEST_MS = '600000';
      process.env.EPG_STAGE_STALE_MS = '60000';
      expect(resolveStageStaleMs()).toBeGreaterThanOrEqual(600000);

      process.env.HTTP_MAX_REQUEST_MS = '3600000';
      expect(resolveStageStaleMs()).toBeGreaterThanOrEqual(3600000);

      delete process.env.EPG_STAGE_STALE_MS;
      expect(resolveStageStaleMs()).toBeGreaterThanOrEqual(3600000);
    } finally {
      if (previous === undefined) delete process.env.HTTP_MAX_REQUEST_MS;
      else process.env.HTTP_MAX_REQUEST_MS = previous;
      if (previousStale === undefined) delete process.env.EPG_STAGE_STALE_MS;
      else process.env.EPG_STAGE_STALE_MS = previousStale;
    }
  });

  it('numbers a run by its start, not by when its headers arrive', async () => {
    // Import A starts first but its headers are delayed; B starts later and
    // answers immediately. A must still carry the lower sequence.
    const seen = [];
    const slowHeaders = new Promise(resolve => setTimeout(resolve, 150));
    fetchSafe.mockImplementation(async () => {
      seen.push(Date.now());
      if (seen.length === 1) await slowHeaders;
      return { ok: true, body: Readable.from([xml([{ start: future(1), stop: future(2), title: `Run ${seen.length}` }])]) };
    });

    const first = importEpgFromUrl('https://epg.example/a.xml', SOURCE_TYPE, SOURCE_ID);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = importEpgFromUrl('https://epg.example/b.xml', SOURCE_TYPE, SOURCE_ID);

    const results = await Promise.allSettled([first, second]);
    // The later-started run wins; the earlier one is refused on promotion.
    expect(results[1].status).toBe('fulfilled');
    expect(results[0].status).toBe('rejected');
    expect(String(results[0].reason?.message)).toMatch(/newer EPG import already promoted/i);

    const titles = epgDb.prepare('SELECT title FROM epg_programs WHERE source_type = ? AND source_id = ?')
      .all(SOURCE_TYPE, SOURCE_ID).map(r => r.title);
    expect(titles).toEqual(['Run 2']);
  });

  it('rejects an unusable source identity instead of building a table name from it', () => {
    expect(stagingTableNames('custom"; DROP TABLE epg_channels; --', 1, 'tok', 1000).channels)
      .toBe(`${EPG_STAGE_PREFIX}channels_customdroptableepgchannels_1_${(1000).toString(36)}_tok`);
    expect(() => stagingTableNames('custom', '1; DROP TABLE epg_channels')).toThrow(/Invalid EPG source identity/);
    expect(() => stagingTableNames('', 1)).toThrow(/Invalid EPG source identity/);
    // A hostile token cannot inject DDL: only [a-z0-9] survives, and an empty
    // result is rejected.
    const hostile = stagingTableNames('custom', 1, '"; DROP TABLE epg_channels; --');
    expect(hostile.channels).toMatch(/^[a-z0-9_]+$/);
    expect(hostile.programs).toMatch(/^[a-z0-9_]+$/);
    expect(() => stagingTableNames('custom', 1, '!!!')).toThrow(/Invalid EPG source identity/);
    expect(() => stagingTableNames('custom', 1, 'tok', 0)).toThrow(/Invalid EPG source identity/);
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

  it('sweeps only staging tables that are old enough to be abandoned', () => {
    const now = Date.now();
    const fresh = stagingTableNames(SOURCE_TYPE, SOURCE_ID, 'freshrun', now - 60000);
    const abandoned = stagingTableNames(SOURCE_TYPE, SOURCE_ID, 'oldrun', now - 7 * 60 * 60 * 1000);
    epgDb.exec(`CREATE TABLE ${fresh.channels} (id TEXT); CREATE TABLE ${fresh.programs} (id TEXT);`);
    epgDb.exec(`CREATE TABLE ${abandoned.channels} (id TEXT); CREATE TABLE ${abandoned.programs} (id TEXT);`);
    expect(stagingTableCount()).toBe(4);

    // During an overlapping restart another process may still be filling its
    // tables, so a blanket sweep would break its prepared inserts.
    expect(dropOrphanedStagingTables(epgDb, { now })).toBe(2);
    expect(stagingTableCount()).toBe(2);
    expect(stagingTableStartedAt(fresh.channels)).toBe(now - 60000);

    epgDb.exec(`DROP TABLE ${fresh.channels}; DROP TABLE ${fresh.programs};`);
  });

  it('refuses a promotion from a run that started before the current snapshot', async () => {
    // A slower import that started earlier must not roll back the newer feed.
    fetchSafe.mockResolvedValue({
      ok: true,
      body: Readable.from([xml([{ start: future(1), stop: future(2), title: 'Newer Show' }])]),
    });
    await importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID);
    const promotedSeq = epgDb.prepare('SELECT promoted_seq FROM epg_import_state WHERE source_type = ? AND source_id = ?')
      .get(SOURCE_TYPE, SOURCE_ID).promoted_seq;
    expect(promotedSeq).toBeGreaterThan(0);

    // Pretend a much newer import already promoted while this one was parsing.
    epgDb.prepare('UPDATE epg_import_state SET promoted_seq = ? WHERE source_type = ? AND source_id = ?')
      .run(promotedSeq + 3600000, SOURCE_TYPE, SOURCE_ID);

    fetchSafe.mockResolvedValue({
      ok: true,
      body: Readable.from([xml([{ start: future(3), stop: future(4), title: 'Older Show' }])]),
    });
    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID))
      .rejects.toThrow(/newer EPG import already promoted/i);

    const titles = epgDb.prepare('SELECT title FROM epg_programs WHERE source_type = ? AND source_id = ?')
      .all(SOURCE_TYPE, SOURCE_ID).map(r => r.title);
    expect(titles).toEqual(['Newer Show']);
    expect(stagingTableCount()).toBe(0);
  });
});
