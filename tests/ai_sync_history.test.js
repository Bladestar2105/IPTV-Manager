import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(),'iptv-ai-sync-'));
process.env.DATA_DIR=dataDir;
// Exercise real rule/snapshot domains while observing the independent job handoff.
vi.mock('../src/services/ai/jobs.js',()=>({createJob:vi.fn()}));
let db,captureSyncSnapshot,recordSyncSnapshot,scheduleSyncFollowups,createJob,provider,user,category,channel,assignment;

beforeAll(async () => {
  const database=await import('../src/database/db.js');db=database.default;database.initDb(true);
  ({captureSyncSnapshot,recordSyncSnapshot,scheduleSyncFollowups}=await import('../src/services/ai/syncHistory.js'));
  ({createJob}=await import('../src/services/ai/jobs.js'));
  user=Number(db.prepare("INSERT INTO users (username,password) VALUES ('history-user','unused')").run().lastInsertRowid);
  provider=Number(db.prepare("INSERT INTO providers (name,url,username,password,user_id) VALUES ('Provider','https://upstream.invalid','secret-user','secret-key',?)").run(user).lastInsertRowid);
  category=Number(db.prepare("INSERT INTO user_categories (user_id,name) VALUES (?,'My list')").run(user).lastInsertRowid);
  channel=Number(db.prepare("INSERT INTO provider_channels (provider_id,remote_stream_id,name,metadata) VALUES (?,1,'Old channel','{\"http_headers\":\"private-key\"}')").run(provider).lastInsertRowid);
  assignment=Number(db.prepare("INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(category,channel).lastInsertRowid);
});

async function followupFixture(label,count) {
  createJob.mockClear();
  const owner=Number(db.prepare("INSERT INTO users(username,password) VALUES (?,'unused')").run(label).lastInsertRowid);
  const source=Number(db.prepare("INSERT INTO providers(name,url,username,password,user_id) VALUES (?,'https://sync.invalid','unused','unused',?)").run(label,owner).lastInsertRowid);
  const list=Number(db.prepare("INSERT INTO user_categories(user_id,name) VALUES (?,'Sync list')").run(owner).lastInsertRowid);
  const insertChannel=db.prepare('INSERT INTO provider_channels(provider_id,remote_stream_id,name) VALUES (?,?,?)');
  const insertAssignment=db.prepare("INSERT INTO user_channels(user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')");
  const confirmedChannel=Number(insertChannel.run(source,1,'Prefix | Confirmed').lastInsertRowid);
  const confirmedAssignment=Number(insertAssignment.run(list,confirmedChannel).lastInsertRowid);
  const actor={id:owner,is_admin:false};
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('ai_policy',?)").run(JSON.stringify({enabled:true,allowed_user_ids:[owner],functions:['cleanup','sync']}));
  db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES (?,?)').run(`user:${owner}`,JSON.stringify({enabled:true,auto_sync_summary:true}));
  const {createProposal,applyProposal}=await import('../src/services/ai/proposals.js');
  const {saveRule}=await import('../src/services/ai/library.js');
  const proposal=createProposal(actor,{feature:'cleanup',user_id:owner},[{type:'rename_channel',user_channel_id:confirmedAssignment,value:'Confirmed'}],'Confirmed cleanup');
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:`confirm-${owner}`});
  const rule=saveRule(actor,{proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Prefix cleanup',operation:'strip_prefix',match:'Prefix | ',enabled:true});
  const before=captureSyncSnapshot(source),added=[];
  db.transaction(()=>{
    for(let i=0;i<count;i++) {
      const channelId=Number(insertChannel.run(source,i+2,`Prefix | Item ${i}`).lastInsertRowid);
      added.push({channelId,id:Number(insertAssignment.run(list,channelId).lastInsertRowid)});
    }
  })();
  return {actor,rule,added,records:recordSyncSnapshot(source,before)};
}

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

it('processes more than 5000 added assignments and dispatches one independent summary',async()=>{
  const fixture=await followupFixture('large-followup',5001);
  db.prepare("UPDATE user_channels SET custom_name='Keep mine' WHERE id=?").run(fixture.added[0].id);
  scheduleSyncFollowups(fixture.records);
  await vi.waitFor(()=>expect(createJob).toHaveBeenCalledTimes(1),{timeout:5000});
  expect(createJob).toHaveBeenCalledWith(fixture.actor,{feature:'sync',snapshot_id:fixture.records[0].id},`sync_${fixture.records[0].id}`);
  const name=id=>db.prepare('SELECT custom_name,assignment_origin FROM user_channels WHERE id=?').get(id);
  expect(name(fixture.added[0].id)).toEqual({custom_name:'Keep mine',assignment_origin:'manual'});
  expect(name(fixture.added.at(-1).id)).toEqual({custom_name:'Item 5000',assignment_origin:'manual'});
  const changes=db.prepare("SELECT id,data_json FROM ai_changes WHERE json_extract(data_json,'$.rule_id')=? ORDER BY rowid").all(fixture.rule.id);
  expect(changes.map(row=>JSON.parse(row.data_json).diffs.length)).toEqual([4999,1]);
  const {undoChange}=await import('../src/services/ai/proposals.js');
  for(const change of changes) expect(undoChange(fixture.actor,change.id).status).toBe('undone');
  expect(name(fixture.added[0].id).custom_name).toBe('Keep mine');
  expect(name(fixture.added[1].id).custom_name).toBe('');
  expect(name(fixture.added.at(-1).id).custom_name).toBe('');
},10000);

it('still dispatches the selected summary when a rule transaction fails',async()=>{
  const fixture=await followupFixture('failed-rule-followup',1);
  db.exec(`CREATE TRIGGER fail_rule_update BEFORE UPDATE OF custom_name ON user_channels WHEN NEW.id=${fixture.added[0].id} BEGIN SELECT RAISE(ABORT,'synthetic rule failure'); END`);
  try {
    scheduleSyncFollowups(fixture.records);
    await vi.waitFor(()=>expect(createJob).toHaveBeenCalledTimes(1),{timeout:1000});
    expect(createJob).toHaveBeenCalledWith(fixture.actor,{feature:'sync',snapshot_id:fixture.records[0].id},`sync_${fixture.records[0].id}`);
    expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=?').get(fixture.added[0].id).custom_name).toBe('');
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_changes WHERE json_extract(data_json,'$.rule_id')=?").get(fixture.rule.id).n).toBe(0);
  } finally { db.exec('DROP TRIGGER fail_rule_update'); }
});

it('loads eligible assignments once for 100 rules and 5000 added IDs while preserving precedence and Undo',async()=>{
  const fixture=await followupFixture('bounded-rule-queries',5000);
  const {saveRule,applyRulesAfterSync}=await import('../src/services/ai/library.js');
  saveRule(fixture.actor,{exceptions:['Special']},fixture.rule.id);
  db.prepare('UPDATE ai_rules SET created_at=0 WHERE id=?').run(fixture.rule.id);
  const later=saveRule(fixture.actor,{...fixture.rule,name:'Later cleanup',exceptions:[],enabled:true});
  db.prepare('UPDATE ai_rules SET created_at=1 WHERE id=?').run(later.id);
  for(let i=2;i<100;i++) saveRule(fixture.actor,{...fixture.rule,name:`Later cleanup ${i}`,enabled:true});
  db.prepare("UPDATE user_channels SET custom_name='Keep mine' WHERE id=?").run(fixture.added[0].id);
  db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=?').run(fixture.added[1].id);
  db.prepare('UPDATE user_channels SET custom_name=NULL WHERE id=?').run(fixture.added[2].id);
  db.prepare("UPDATE provider_channels SET name='Prefix | Special' WHERE id=?").run(fixture.added[3].channelId);
  db.prepare("UPDATE provider_channels SET name='Unmatched' WHERE id=?").run(fixture.added.at(-1).channelId);
  const extraCategory=Number(db.prepare("INSERT INTO user_categories(user_id,name) VALUES (?,'Second assignment')").run(fixture.actor.id).lastInsertRowid);
  const duplicate=Number(db.prepare("INSERT INTO user_channels(user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(extraCategory,fixture.added[2].channelId).lastInsertRowid);
  const foreign=Number(db.prepare("INSERT INTO user_channels(user_category_id,provider_channel_id,assignment_origin,granted_by_admin) VALUES (?,?,'manual',1)").run(category,fixture.added[2].channelId).lastInsertRowid);
  const source=db.prepare('SELECT provider_id FROM provider_channels WHERE id=?').get(fixture.added[0].channelId).provider_id;
  const unselected=Number(db.prepare("INSERT INTO provider_channels(provider_id,remote_stream_id,name) VALUES (?,99999,'Prefix | Unselected')").run(source).lastInsertRowid);
  db.prepare("INSERT INTO user_channels(user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(extraCategory,unselected);
  const rows=()=>db.prepare(`SELECT uc.* FROM user_channels uc JOIN user_categories cat ON cat.id=uc.user_category_id
    WHERE cat.user_id=? OR uc.id=? ORDER BY uc.id`).all(fixture.actor.id,foreign);
  const before=rows();
  // Count executed catalog reads, including reuse of a prepared statement; avoid timing-dependent assertions.
  const prepare=db.prepare;
  let reads=0,result;
  db.prepare=function(sql,...args) {
    const statement=prepare.call(this,sql,...args);
    if(sql.includes('FROM authorized_user_channels')&&sql.includes('COALESCE(uc.custom_name')) {
      const all=statement.all;
      statement.all=function(...params) {reads++;return all.apply(this,params);};
    }
    return statement;
  };
  try { result=applyRulesAfterSync(fixture.actor.id,fixture.added.map(row=>row.channelId)); }
  finally { db.prepare=prepare; }
  expect(reads).toBe(1);
  expect(result).toEqual({applied:4998});
  const changes=db.prepare("SELECT id,data_json FROM ai_changes WHERE user_id=? AND json_extract(data_json,'$.rule_id') IS NOT NULL ORDER BY rowid").all(fixture.actor.id);
  expect(changes.map(row=>({rule:JSON.parse(row.data_json).rule_id,count:JSON.parse(row.data_json).diffs.length}))).toEqual([
    {rule:fixture.rule.id,count:4997},{rule:later.id,count:1}
  ]);
  const changed=new Map(rows().map(row=>[row.id,row]));
  expect(changed.get(fixture.added[0].id).custom_name).toBe('Keep mine');
  expect(changed.get(fixture.added[1].id).custom_name).toBe('');
  expect(changed.get(fixture.added[2].id).custom_name).toBe('Item 2');
  expect(changed.get(duplicate).custom_name).toBe('Item 2');
  expect(changed.get(fixture.added[3].id).custom_name).toBe('Special');
  expect(changed.get(foreign).custom_name).toBe('');
  expect([...changed.values()].find(row=>row.provider_channel_id===unselected).custom_name).toBe('');
  const {undoChange}=await import('../src/services/ai/proposals.js');
  for(const change of changes) expect(undoChange(fixture.actor,change.id).status).toBe('undone');
  expect(rows()).toEqual(before);
},30000);
