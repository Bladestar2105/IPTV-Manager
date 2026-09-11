import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-epg-search-'));
process.env.DATA_DIR = dataDir;
const user = { id: 701, is_admin: false, username: 'one', provider_access: 0 };
let db, epg, buildContext, searchLocally, verifyPrograms, executeFeature, authorizeResult, start;

beforeAll(async () => {
  const main = await import('../src/database/db.js');
  db = main.default;
  main.initDb(true);
  const guide = await import('../src/database/epgDb.js');
  epg = guide.default;
  guide.initEpgDb();
  ({ buildContext } = await import('../src/services/ai/context.js'));
  ({ searchLocally, verifyPrograms } = await import('../src/services/ai/searchAndEpg.js'));
  ({ executeFeature, authorizeResult } = await import('../src/services/ai/features.js'));
});

beforeEach(() => {
  for (const table of ['ai_conversations', 'user_channels', 'user_categories', 'provider_channels', 'providers', 'epg_sources', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  epg.exec('DELETE FROM epg_programs; DELETE FROM epg_channels');
  db.exec(`INSERT INTO users(id,username,password) VALUES (701,'one','x'),(702,'two','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES
      (801,'First','https://first.invalid','test','test',701),(802,'Foreign','https://foreign.invalid','test','test',702);
    INSERT INTO epg_sources(id,name,url,enabled) VALUES (851,'Custom guide','https://guide.invalid',1);
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,epg_channel_id) VALUES
      (901,801,1,'News channel','live','news'),(902,801,2,'Sports channel','live','sports'),(903,802,3,'Foreign channel','live','news');
    INSERT INTO user_categories(id,user_id,name) VALUES (1001,701,'My list'),(1002,702,'Foreign list');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,sort_order,assignment_origin) VALUES
      (1101,1001,901,0,'manual'),(1102,1001,902,1,'manual'),(1103,1002,903,0,'manual');`);
  start = Math.floor(Date.now() / 1000) + 60;
});

afterAll(() => {
  epg?.close();
  db?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function addPrograms(count, { channel = 'news', type = 'provider', sourceId = 801, title = index => `Schedule ${index}` } = {}) {
  epg.prepare('INSERT OR IGNORE INTO epg_channels(id,name,source_type,source_id) VALUES(?,?,?,?)').run(channel, channel, type, sourceId);
  const insert = epg.prepare('INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES(?,?,?,?,?,?,?,?)');
  epg.transaction(() => {
    for (let index = 0; index < count; index++) {
      insert.run(channel, type, sourceId, start + index, start + index + 3600, title(index), 'Programme description', 'en');
    }
  })();
}

function search(filters = {}) {
  return searchLocally(user, buildContext(user, { feature: 'search' }), { type: 'program', query: 'UniqueTarget', ...filters }, 'UTC');
}

describe('bounded authorized EPG search', () => {
  it('uses disposable main and EPG databases', () => {
    expect(db.name).toBe(path.join(dataDir, 'db.sqlite'));
    expect(epg.name).toBe(path.join(dataDir, 'epg.db'));
    expect(path.dirname(dataDir)).toBe(os.tmpdir());
  });

  it.each([100, 101, 102, 200])('finds a sole match at programme %i and recognizes the complete final page', count => {
    addPrograms(count, { title: index => index === count - 1 ? 'UniqueTarget' : 'Other programme' });
    const result = search();
    expect(result.items.map(item => item.start)).toEqual([start + count - 1]);
    expect(result.program_refs).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(() => verifyPrograms(user, user.id, result.program_refs)).not.toThrow();
  });

  it('keeps equal starts in different authorized channels and sources distinct across pages', () => {
    for (const channel of ['news', 'sports']) {
      addPrograms(104, { channel, title: index => index >= 101 ? 'UniqueTarget' : 'Other programme' });
      addPrograms(104, { channel, type: 'custom', sourceId: 851, title: index => index >= 101 ? 'UniqueTarget' : 'Other programme' });
    }
    addPrograms(104, { sourceId: 802, title: () => 'UniqueTarget foreign programme' });
    const result = search();
    const identities = result.items.map(item => [item.provider_channel_id, item.program.source_type, item.program.source_id, item.start]);
    expect(identities).toEqual([
      [901, 'provider', 801, start + 101], [901, 'provider', 801, start + 102], [901, 'provider', 801, start + 103],
      [901, 'custom', 851, start + 101], [901, 'custom', 851, start + 102], [901, 'custom', 851, start + 103],
      [902, 'provider', 801, start + 101], [902, 'provider', 801, start + 102], [902, 'provider', 801, start + 103],
      [902, 'custom', 851, start + 101], [902, 'custom', 851, start + 102], [902, 'custom', 851, start + 103]
    ]);
    expect(new Set(result.program_refs.map(ref => JSON.stringify(ref))).size).toBe(12);
    expect(result.truncated).toBe(false);
    expect(search()).toEqual(result);
    expect(() => verifyPrograms(user, user.id, result.program_refs)).not.toThrow();
  });

  it.each([[100, false], [101, true]])('returns at most 100 matches from %i programmes with correct partial status', (count, partial) => {
    addPrograms(count, { title: () => 'UniqueTarget' });
    addPrograms(0, { channel: 'sports' });
    const result = search();
    expect(result.items).toHaveLength(100);
    expect(result.program_refs).toHaveLength(100);
    expect(result.truncated).toBe(partial);
  });

  it.each([4999, 5000])('finds the final matching programme in a complete %i-row window', count => {
    addPrograms(count, { title: index => index === count - 1 ? 'UniqueTarget' : 'Other programme' });
    const result = search();
    expect(result.items.map(item => item.start)).toEqual([start + count - 1]);
    expect(result.truncated).toBe(false);
  });

  it('reports partial with zero hits when the only match is beyond the global work budget', () => {
    addPrograms(5001, { title: index => index === 5000 ? 'UniqueTarget' : 'Other programme' });
    expect(search()).toEqual({ items: [], program_refs: [], truncated: true });
  });

  it('shares the 5000-programme budget across channels and flags the unexamined remainder', () => {
    addPrograms(3000);
    addPrograms(2001, { channel: 'sports', title: index => index >= 1999 ? 'UniqueTarget' : 'Other programme' });
    const result = search();
    expect(result.items.map(item => [item.provider_channel_id, item.start])).toEqual([[902, start + 1999]]);
    expect(result.truncated).toBe(true);
  });

  it('reports partial if an unexamined source follows the 100th result', () => {
    addPrograms(100, { title: () => 'UniqueTarget' });
    addPrograms(1, { type: 'custom', sourceId: 851, title: () => 'UniqueTarget' });
    const result = search();
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('reports partial when the authorized EPG catalog cap can omit a matching source', () => {
    const insert = epg.prepare("INSERT INTO epg_channels(id,name,source_type,source_id) VALUES(?,'Other guide channel','provider',801)");
    epg.transaction(() => {
      for (let index = 0; index < 5000; index++) insert.run(`a${index}`);
    })();
    addPrograms(1, { title: () => 'UniqueTarget' });
    expect(search()).toEqual({ items: [], program_refs: [], truncated: true });
  });

  it.each(['source', 'channel', 'programme'])('invalidates a displayed paginated result after its %s changes', async change => {
    addPrograms(102, { type: 'custom', sourceId: 851, title: index => index === 101 ? 'UniqueTarget' : 'Other programme' });
    const result = await executeFeature(user, { feature: 'search' }, {
      infer: async () => ({ data: { summary: 'Matching programme', filters: { type: 'program', query: 'UniqueTarget' }, clear_filters: [] }, model: 'synthetic' })
    });
    expect(result.items).toHaveLength(1);
    expect(result.coverage.results_partial).toBe(false);
    expect(() => authorizeResult(user, { feature: 'search' }, result)).not.toThrow();
    if (change === 'source') db.prepare('UPDATE epg_sources SET enabled=0 WHERE id=851').run();
    if (change === 'channel') db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1101').run();
    if (change === 'programme') epg.prepare("UPDATE epg_programs SET title='Replacement programme' WHERE start=?").run(start + 101);
    expect(() => authorizeResult(user, { feature: 'search' }, result)).toThrow(/AI_SOURCE_UNAVAILABLE|AI_STALE_SOURCE/);
  });
});
