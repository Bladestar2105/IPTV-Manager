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
  resolveStageStaleMs, claimPromotionSequence, ensureImportStateTable, EPG_STAGE_PREFIX,
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

  it('issues a strictly monotonic promotion sequence per source', () => {
    // A millisecond timestamp collides when two workers start inside the same
    // millisecond, and a clock that steps back inverts the order outright.
    ensureImportStateTable(epgDb);
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(claimPromotionSequence(epgDb, SOURCE_TYPE, SOURCE_ID));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBeGreaterThan(0);

    // A different source has its own counter.
    const other = claimPromotionSequence(epgDb, SOURCE_TYPE, SOURCE_ID + 1);
    expect(other).toBe(1);
    epgDb.prepare('DELETE FROM epg_import_state WHERE source_type = ? AND source_id = ?').run(SOURCE_TYPE, SOURCE_ID + 1);
  });

  it('lifts a legacy timestamp promotion into the counter domain', async () => {
    // A database written by the timestamp-based implementation carries a
    // millisecond value in promoted_seq. Without rebasing, the next claim is 1,
    // every promotion is rejected as older, and the source can never update again.
    const legacy = Date.now();
    ensureImportStateTable(epgDb);
    epgDb.prepare(`INSERT INTO epg_import_state (source_type, source_id, promoted_at, promoted_seq, claimed_seq)
                   VALUES (?, ?, ?, ?, 0)
                   ON CONFLICT(source_type, source_id) DO UPDATE SET promoted_seq = excluded.promoted_seq, claimed_seq = 0`)
      .run(SOURCE_TYPE, SOURCE_ID, Math.floor(legacy / 1000), legacy);

    initEpgDb();   // idempotent migration

    const state = epgDb.prepare('SELECT claimed_seq, promoted_seq FROM epg_import_state WHERE source_type = ? AND source_id = ?')
      .get(SOURCE_TYPE, SOURCE_ID);
    expect(state.claimed_seq).toBeGreaterThanOrEqual(state.promoted_seq);

    fetchSafe.mockResolvedValue({
      ok: true,
      body: Readable.from([xml([{ start: future(1), stop: future(2), title: 'After upgrade' }])]),
    });
    await expect(importEpgFromUrl('https://epg.example/guide.xml', SOURCE_TYPE, SOURCE_ID))
      .resolves.toMatchObject({ success: true });

    const titles = epgDb.prepare('SELECT title FROM epg_programs WHERE source_type = ? AND source_id = ?')
      .all(SOURCE_TYPE, SOURCE_ID).map(r => r.title);
    expect(titles).toEqual(['After upgrade']);
  });

  it('outruns a promotion written after the migration rebased the counter', () => {
    // A writer from the timestamp-based build can promote after initEpgDb() has
    // rebased the counter. Incrementing claimed_seq alone would leave every
    // later claim below that value and the source unpromotable until a restart.
    ensureImportStateTable(epgDb);
    epgDb.prepare(`INSERT INTO epg_import_state (source_type, source_id, promoted_at, promoted_seq, claimed_seq)
                   VALUES (?, ?, 0, 0, 1)
                   ON CONFLICT(source_type, source_id) DO UPDATE SET promoted_seq = 0, claimed_seq = 1`)
      .run(SOURCE_TYPE, SOURCE_ID);

    const legacyPromotion = Date.now();
    epgDb.prepare('UPDATE epg_import_state SET promoted_seq = ? WHERE source_type = ? AND source_id = ?')
      .run(legacyPromotion, SOURCE_TYPE, SOURCE_ID);

    expect(claimPromotionSequence(epgDb, SOURCE_TYPE, SOURCE_ID)).toBeGreaterThan(legacyPromotion);
  });

  it('numbers a run by its start, not by when its headers arrive', async () => {
    // Import A starts first but its headers are withheld until B has finished.
    // A must still carry the lower sequence and lose the promotion.
    let aEntered;
    const aHasEntered = new Promise(resolve => { aEntered = resolve; });
    let releaseA;
    const aMayAnswer = new Promise(resolve => { releaseA = resolve; });

    let call = 0;
    fetchSafe.mockImplementation(async () => {
      const index = ++call;
      if (index === 1) {
        aEntered();
        await aMayAnswer;
      }
      return { ok: true, body: Readable.from([xml([{ start: future(1), stop: future(2), title: `Run ${index}` }])]) };
    });

    const first = importEpgFromUrl('https://epg.example/a.xml', SOURCE_TYPE, SOURCE_ID);
    await aHasEntered;
    await expect(importEpgFromUrl('https://epg.example/b.xml', SOURCE_TYPE, SOURCE_ID))
      .resolves.toMatchObject({ success: true });

    releaseA();
    await expect(first).rejects.toThrow(/newer EPG import already promoted/i);

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

});
