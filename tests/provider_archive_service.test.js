import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, fetchSafe, readBodyWithLimit, discardBody, acquireLock, release } = vi.hoisted(() => ({
  state: {}, fetchSafe: vi.fn(), readBodyWithLimit: vi.fn(), discardBody: vi.fn(), acquireLock: vi.fn(), release: vi.fn(),
}));
vi.mock('../src/database/db.js', () => ({ default: { prepare: (...args) => state.main.prepare(...args) } }));
vi.mock('../src/database/epgDb.js', () => ({ default: {
  prepare: (...args) => state.epg.prepare(...args),
  transaction: (...args) => state.epg.transaction(...args),
  get inTransaction() { return state.epg.inTransaction; },
} }));
vi.mock('../src/utils/network.js', () => ({ fetchSafe, readBodyWithLimit, discardBody }));
vi.mock('../src/utils/crypto.js', () => ({ decrypt: value => value }));
vi.mock('../src/services/providerLockService.js', () => ({ acquireLock }));

state.main = new Database(':memory:');
state.epg = new Database(':memory:');
state.main.exec(`
  CREATE TABLE providers (id INTEGER PRIMARY KEY, url TEXT, username TEXT, password TEXT);
  CREATE TABLE provider_channels (id INTEGER PRIMARY KEY, provider_id INTEGER, remote_stream_id INTEGER,
    name TEXT, stream_type TEXT, epg_channel_id TEXT, tv_archive INTEGER, tv_archive_duration INTEGER);
  CREATE TABLE user_categories (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT);
  CREATE TABLE user_channels (id INTEGER PRIMARY KEY, provider_channel_id INTEGER, user_category_id INTEGER,
    is_hidden INTEGER DEFAULT 0, authorization_revoked INTEGER DEFAULT 0);
  CREATE VIEW authorized_user_channels AS SELECT * FROM user_channels WHERE authorization_revoked = 0;
  CREATE TABLE epg_channel_mappings (provider_channel_id INTEGER, epg_channel_id TEXT);
  INSERT INTO providers VALUES (1, 'https://provider.invalid', 'upstream-user', 'upstream-secret');
  INSERT INTO provider_channels VALUES (11, 1, 789, 'News', 'live', 'news', 1, 30);
  INSERT INTO user_categories VALUES (21, 7, 'live');
  INSERT INTO user_channels VALUES (101, 11, 21, 0, 0);
`);
state.epg.exec(`
  CREATE TABLE epg_channels (id TEXT, name TEXT, logo TEXT, source_type TEXT, source_id INTEGER, updated_at INTEGER,
    PRIMARY KEY (id, source_type, source_id));
  CREATE TABLE epg_programs (channel_id TEXT, source_type TEXT, source_id INTEGER, start INTEGER, stop INTEGER,
    title TEXT, desc TEXT, lang TEXT, PRIMARY KEY (channel_id, source_type, source_id, start));
`);

const { refreshProviderArchive } = await import('../src/services/providerArchiveService.js');
const now = 1800000000;
const oldStart = now - 20 * 86400;
const encoded = value => Buffer.from(value).toString('base64');
const archive = () => ({ start_timestamp: oldStart, stop_timestamp: oldStart + 3600,
  title: encoded('Twenty days ago'), description: encoded('Historic show'), channel_id: 'upstream-identity',
  url: 'https://provider.invalid/upstream-user/upstream-secret', stream_icon: 'https://provider.invalid/private.jpg' });
const stored = () => state.epg.prepare('SELECT * FROM epg_programs ORDER BY start').all();

describe('lazy provider archive backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    state.main.exec(`UPDATE user_channels SET is_hidden = 0, authorization_revoked = 0;
      UPDATE provider_channels SET tv_archive = 1, tv_archive_duration = 30;
      DELETE FROM epg_channel_mappings;`);
    state.epg.exec('DELETE FROM epg_programs; DELETE FROM epg_channels;');
    acquireLock.mockReturnValue({ release });
    fetchSafe.mockResolvedValue({ ok: true });
    readBodyWithLimit.mockResolvedValue({ epg_listings: [archive()] });
  });

  afterAll(() => { vi.restoreAllMocks(); state.main.close(); state.epg.close(); });

  it('recovers older upstream history without replacing current or custom source programmes', async () => {
    state.main.prepare('INSERT INTO epg_channel_mappings VALUES (11, ?)').run('manual-news');
    state.epg.prepare("INSERT INTO epg_channels VALUES ('manual-news', 'Custom News', '', 'custom', 99, ?)").run(now);
    state.epg.prepare("INSERT INTO epg_programs VALUES ('manual-news', 'custom', 99, ?, ?, 'Custom past', '', '')").run(oldStart + 7200, oldStart + 10800);
    state.epg.prepare("INSERT INTO epg_programs VALUES ('manual-news', 'custom', 99, ?, ?, 'Local current', '', '')").run(now - 60, now + 3600);
    readBodyWithLimit.mockResolvedValue({ epg_listings: [archive(), {
      ...archive(), start_timestamp: now - 60, stop_timestamp: now + 3600, title: encoded('Upstream current'),
    }, {
      ...archive(), start_timestamp: oldStart + 7200, stop_timestamp: oldStart + 10800, title: encoded('Overlapping custom past'),
    }] });

    expect(await refreshProviderArchive(101, 7, async () => true)).toBe(true);

    expect(fetchSafe).toHaveBeenCalledWith(expect.stringContaining('action=get_simple_data_table'), expect.objectContaining({ timeout: 10000, maxDurationMs: 10000 }));
    const url = new URL(fetchSafe.mock.calls[0][0]);
    expect(url.searchParams.get('stream_id')).toBe('789');
    expect(url.searchParams.get('username')).toBe('upstream-user');
    expect(readBodyWithLimit).toHaveBeenCalledWith(expect.anything(), { as: 'json', timeoutMs: 10000, maxBytes: 8 * 1024 * 1024 });
    expect(stored().map(row => row.title)).toEqual(['Twenty days ago', 'Custom past', 'Local current']);
    expect(stored().find(row => row.source_type === 'provider')).toMatchObject({ channel_id: 'manual-news', source_id: 1, desc: 'Historic show' });
    expect(JSON.stringify(stored())).not.toContain('upstream-secret');
    expect(release).toHaveBeenCalledWith(60);
  });

  it.each(['hidden', 'revoked', 'other-user', 'archive-disabled'])('does not fetch a %s channel', async scenario => {
    if (scenario === 'hidden') state.main.exec('UPDATE user_channels SET is_hidden = 1');
    if (scenario === 'revoked') state.main.exec('UPDATE user_channels SET authorization_revoked = 1');
    if (scenario === 'archive-disabled') state.main.exec('UPDATE provider_channels SET tv_archive = 0');

    await refreshProviderArchive(101, scenario === 'other-user' ? 8 : 7, async () => true);

    expect(fetchSafe).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('rechecks authorization after the provider responds and discards a revoked result', async () => {
    readBodyWithLimit.mockImplementation(async () => {
      state.main.exec('UPDATE user_channels SET authorization_revoked = 1');
      return { epg_listings: [archive()] };
    });

    expect(await refreshProviderArchive(101, 7, async () => true)).toBe(false);
    expect(stored()).toEqual([]);
  });

  it('ignores expired, incomplete and invalid upstream rows', async () => {
    readBodyWithLimit.mockResolvedValue({ epg_listings: [archive(),
      { ...archive(), start_timestamp: now - 31 * 86400, stop_timestamp: now - 31 * 86400 + 60 },
      { ...archive(), start_timestamp: now - 1, stop_timestamp: now + 1 },
      { ...archive(), stop_timestamp: 'invalid' },
      { ...archive(), stop_timestamp: oldStart - 1 },
    ] });

    await refreshProviderArchive(101, 7, async () => true);

    expect(stored()).toHaveLength(1);
    expect(stored()[0].title).toBe('Twenty days ago');
  });

  it.each(['title', 'description', 'lang'].flatMap(field => [
    ['raw', 'https://provider.invalid/upstream-user/upstream-secret'],
    ['encoded', encoded('https://provider.invalid/upstream-user/upstream-secret')],
    ['embedded', 'Mehr dazu: https://provider.invalid/upstream-user/upstream-secret heute.'],
    ['encoded embedded', encoded('Mehr dazu: https://provider.invalid/upstream-user/upstream-secret heute.')],
    ['protocol relative', '//provider.invalid/upstream-user/upstream-secret'],
  ].map(([kind, value]) => [field, kind, value])))('redacts %s containing a %s resource before storage', async (field, _kind, value) => {
    readBodyWithLimit.mockResolvedValue({ epg_listings: [{ ...archive(), [field]: value }] });

    await refreshProviderArchive(101, 7, async () => true);

    expect(stored()).toHaveLength(1);
    expect(JSON.stringify(stored())).not.toMatch(/provider\.invalid|upstream-user|upstream-secret/);
    if (field === 'lang') expect(stored()[0].lang).toBe('');
  });

  it('preserves Unicode prose and valid language tags while retaining only policy-approved public links', async () => {
    readBodyWithLimit.mockResolvedValue({ epg_listings: [{ ...archive(),
      title: encoded('Über die Welt – 東京'), description: encoded('Café für alle 🎬 https://www.imdb.com/title/tt123/'), lang: encoded('de-DE'),
    }] });

    await refreshProviderArchive(101, 7, async () => true);

    expect(stored()[0]).toMatchObject({ title: 'Über die Welt – 東京', desc: 'Café für alle 🎬 https://www.imdb.com/title/tt123/', lang: 'de-DE' });
  });

  it('deduplicates simultaneous lookups and honors the shared cooldown lock', async () => {
    let resolveBody;
    readBodyWithLimit.mockReturnValue(new Promise(resolve => { resolveBody = resolve; }));
    const first = refreshProviderArchive(101, 7, async () => true);
    const second = refreshProviderArchive(101, 7, async () => true);
    await Promise.resolve();
    resolveBody({ epg_listings: [archive()] });
    await Promise.all([first, second]);
    expect(fetchSafe).toHaveBeenCalledTimes(1);
    acquireLock.mockReturnValue(null);

    expect(await refreshProviderArchive(101, 7, async () => true)).toBe(true);
    expect(fetchSafe).toHaveBeenCalledTimes(1);
  });

  it('keeps available local history when a bounded provider lookup fails', async () => {
    state.epg.prepare("INSERT INTO epg_channels VALUES ('news', 'News', '', 'provider', 1, ?)").run(now);
    state.epg.prepare("INSERT INTO epg_programs VALUES ('news', 'provider', 1, ?, ?, 'Available local', '', '')").run(now - 7200, now - 3600);
    fetchSafe.mockRejectedValue(new Error('https://provider.invalid?password=upstream-secret'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await refreshProviderArchive(101, 7, async () => true)).toBe(true);

    expect(stored().map(row => row.title)).toEqual(['Available local']);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('upstream-secret');
    expect(release).toHaveBeenCalledWith(60);
    warning.mockRestore();
  });
});
