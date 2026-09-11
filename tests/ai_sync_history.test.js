import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(),'iptv-ai-sync-'));
process.env.DATA_DIR=dataDir;
let db,captureSyncSnapshot,recordSyncSnapshot,provider,user,category,channel,assignment;

beforeAll(async () => {
  const database=await import('../src/database/db.js');db=database.default;database.initDb(true);
  ({captureSyncSnapshot,recordSyncSnapshot}=await import('../src/services/ai/syncHistory.js'));
  user=Number(db.prepare("INSERT INTO users (username,password) VALUES ('history-user','unused')").run().lastInsertRowid);
  provider=Number(db.prepare("INSERT INTO providers (name,url,username,password,user_id) VALUES ('Provider','https://upstream.invalid','secret-user','secret-key',?)").run(user).lastInsertRowid);
  category=Number(db.prepare("INSERT INTO user_categories (user_id,name) VALUES (?,'My list')").run(user).lastInsertRowid);
  channel=Number(db.prepare("INSERT INTO provider_channels (provider_id,remote_stream_id,name,metadata) VALUES (?,1,'Old channel','{\"http_headers\":\"private-key\"}')").run(provider).lastInsertRowid);
  assignment=Number(db.prepare("INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(category,channel).lastInsertRowid);
});
afterAll(()=>{db.close();rmSync(dataDir,{recursive:true,force:true});});

describe('deterministic AI sync history',()=>{
  it('does no capture or history write while disabled',()=>{
    expect(captureSyncSnapshot(provider)).toBeNull();
    expect(recordSyncSnapshot(provider,null)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_sync_snapshots').get().n).toBe(0);
  });
  it('records observed changes without exposing upstream fields',()=>{
    db.prepare("INSERT INTO settings (key,value) VALUES ('ai_policy',?)").run(JSON.stringify({enabled:true}));
    const before=captureSyncSnapshot(provider);
    db.prepare("UPDATE provider_channels SET name='News channel https://host.invalid/key-secret' WHERE id=?").run(channel);
    const saved=recordSyncSnapshot(provider,before);
    const result=JSON.parse(db.prepare('SELECT data_json FROM ai_sync_snapshots WHERE id=?').get(saved[0].id).data_json);
    expect(result.counts).toEqual({added:0,removed:0,renamed:1,reassigned:0});
    expect(result.changes[0]).toMatchObject({kind:'renamed',user_channel_id:assignment,before:{name:'Old channel'},after:{name:'News channel [URL]'}});
    expect(JSON.stringify(result)).not.toMatch(/secret|http_headers|username|password/);
  });
  it('separates users and ignores revoked grants in before and after snapshots',()=>{
    const other=Number(db.prepare("INSERT INTO users (username,password) VALUES ('foreign-user','unused')").run().lastInsertRowid);
    const otherCategory=Number(db.prepare("INSERT INTO user_categories (user_id,name) VALUES (?,'Foreign list')").run(other).lastInsertRowid);
    db.prepare(`INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin,granted_by_admin,authorization_revoked)
      VALUES (?,?,'manual',1,1)`).run(otherCategory,channel);
    const before=captureSyncSnapshot(provider);
    expect(before.map(row=>row.user_id)).toEqual([user]);
    db.prepare('DELETE FROM user_channels WHERE id=?').run(assignment);
    const saved=recordSyncSnapshot(provider,before);
    expect(saved.map(row=>row.user_id)).toEqual([user]);
    const result=JSON.parse(db.prepare('SELECT data_json FROM ai_sync_snapshots WHERE id=?').get(saved[0].id).data_json);
    expect(result.counts.removed).toBe(1);
  });
  it('keeps bounded retention cleanup ahead of repeated syncs affecting more than 100 users',()=>{
    const now=Date.now(),cutoff=now-30*86400000;
    const clock=vi.spyOn(Date,'now').mockReturnValue(now);
    try {
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('ai_policy',?)").run(JSON.stringify({enabled:true}));
      const source=Number(db.prepare("INSERT INTO providers (name,url,username,password,user_id) VALUES ('Retention provider','https://retention.invalid','unused','unused',?)").run(user).lastInsertRowid);
      const sourceChannel=Number(db.prepare("INSERT INTO provider_channels (provider_id,remote_stream_id,name) VALUES (?,1,'Retention channel')").run(source).lastInsertRowid);
      const owners=[];
      const insertUser=db.prepare("INSERT INTO users (username,password) VALUES (?,'unused')");
      const insertCategory=db.prepare("INSERT INTO user_categories (user_id,name) VALUES (?,'Retention list')");
      const insertAssignment=db.prepare("INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin,granted_by_admin) VALUES (?,?,'manual',1)");
      const insertSnapshot=db.prepare('INSERT INTO ai_sync_snapshots (id,user_id,provider_id,data_json,created_at) VALUES (?,?,?,?,?)');
      db.transaction(()=>{
        for(let i=0;i<150;i++) {
          const owner=Number(insertUser.run(`retention-user-${i}`).lastInsertRowid);
          owners.push(owner);
          insertAssignment.run(Number(insertCategory.run(owner).lastInsertRowid),sourceChannel);
        }
        for(let i=0;i<600;i++) insertSnapshot.run(`expired-${i}`,owners[i%150],source,'{}',cutoff-(i%2?1:30*86400000));
        insertSnapshot.run('retained-boundary',owners[0],source,'{}',cutoff);
        insertSnapshot.run('retained-other-owner',user,source,'{}',now);
        insertSnapshot.run('retained-other-provider',owners[0],provider,'{}',now);
      })();
      const controls=db.prepare("SELECT * FROM ai_sync_snapshots WHERE id LIKE 'retained-%' ORDER BY id").all();
      const count=db.prepare('SELECT COUNT(*) AS total,COUNT(CASE WHEN created_at < ? THEN 1 END) AS expired FROM ai_sync_snapshots');
      const initial=count.get(cutoff).total;
      const before=captureSyncSnapshot(source);
      expect(before).toHaveLength(150);
      const remaining=[];
      for(let i=0;i<3;i++) {
        const saved=recordSyncSnapshot(source,before);
        expect(saved.map(record=>record.user_id)).toEqual(owners);
        remaining.push(count.get(cutoff));
      }
      expect(remaining).toEqual([
        {total:initial,expired:450},
        {total:initial,expired:300},
        {total:initial,expired:150}
      ]);
      expect(db.prepare("SELECT * FROM ai_sync_snapshots WHERE id LIKE 'retained-%' ORDER BY id").all()).toEqual(controls);
    } finally { clock.mockRestore(); }
  });
});
