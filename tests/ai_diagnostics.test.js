import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-diagnostics-'));
process.env.DATA_DIR=dataDir;
let db,epg,executeFeature,authorizeResult,streamManager;
const user={id:701,is_admin:false,provider_access:0};
const infer=async()=>({data:{summary:'Local evidence'},model:'test'});
const diagnostic=(result,id)=>result.findings.find(item=>item.code==='channel_diagnostics'&&item.value.provider_channel_id===id)?.value;
const finding=(result,code)=>result.findings.find(item=>item.code===code);

beforeAll(async()=>{
  ({default:db}=await import('../src/database/db.js'));
  (await import('../src/database/db.js')).initDb(true);
  ({default:epg}=await import('../src/database/epgDb.js'));
  (await import('../src/database/epgDb.js')).initEpgDb();
  ({default:streamManager}=await import('../src/services/streamManager.js'));
  ({executeFeature,authorizeResult}=await import('../src/services/ai/features.js'));
});
beforeEach(()=>{
  db.pragma('query_only = OFF');
  streamManager.init(db,null);
  streamManager.localStreams.clear();
  for(const table of ['current_streams','ai_enrichments','ai_conversations','ai_proposals','ai_changes','ai_sync_snapshots','epg_channel_mappings','series_episode_aliases','provider_series_episodes','user_channels','user_categories','provider_channels','providers','users']) db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO users(id,username,password,max_connections,hdhr_enabled) VALUES (701,'one','x',2,1),(702,'two','x',0,0);
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES (801,'First','https://secret.invalid/user/pass','secret','password',701),(802,'Second','https://foreign.invalid','other','password',702);
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,epg_channel_id) VALUES
      (901,801,1,'Hidden news','live','news'),(902,801,2,'Visible news','live',''),
      (903,802,3,'Foreign private channel','live','private'),(904,801,4,'A movie','movie',''),(905,801,5,'A series','series','');
    INSERT INTO user_categories(id,user_id,name) VALUES (1001,701,'My list'),(1002,702,'Foreign list');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,is_hidden) VALUES
      (1101,1001,901,1),(1102,1001,902,0),(1103,1002,903,0),(1104,1001,904,0),(1105,1001,905,0);`);
});
afterAll(()=>{db?.pragma('query_only = OFF');epg?.close();db?.close();fs.rmSync(dataDir,{recursive:true,force:true});});

async function readOnly(payload,options={infer}) {
  const before=db.prepare('SELECT total_changes() AS n').get().n;
  db.pragma('query_only = ON');
  try {
    const result=await executeFeature(user,{feature:'diagnose',...payload},options);
    expect(db.prepare('SELECT total_changes() AS n').get().n).toBe(before);
    return result;
  } finally {db.pragma('query_only = OFF');}
}

describe('read-only local AI diagnosis',()=>{
  it('diagnoses a selected hidden own assignment and excludes every unselected or foreign entry',async()=>{
    let sent='';
    const result=await readOnly({selected_ids:[1101]}, {infer:async request=>{sent=JSON.stringify(request);return infer();}});
    expect(result.coverage.total).toBe(1);
    expect(diagnostic(result,901)).toMatchObject({user_channel_id:1101,category_id:1001,assigned:true,hidden:true,
      local_export_filters:{account_catalog:false,m3u_playlist:false,hdhr_lineup:false}});
    expect(finding(result,'visible_channels')).toMatchObject({certainty:'proven',value:0});
    expect(sent).not.toMatch(/Visible news|Foreign|secret.invalid|password/);
    expect(()=>authorizeResult(user,{feature:'diagnose'},result)).not.toThrow();
    db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1101').run();
    expect(()=>authorizeResult(user,{feature:'diagnose'},result)).toThrow(/AI_SOURCE_UNAVAILABLE/);
  });
  it('also permits an explicitly selected own hidden provider channel',async()=>{
    const result=await readOnly({channel_ids:[901]});
    expect(diagnostic(result,901)).toMatchObject({hidden:true,assigned:true});
  });
  it.each([{selected_ids:[1103]},{channel_ids:[903]},{selected_ids:[1101],channel_ids:[902]}])('rejects foreign or inconsistent selection %j',async payload=>{
    await expect(readOnly(payload)).rejects.toThrow(/AI_SOURCE_UNAVAILABLE/);
  });
  it('rejects a revoked own assignment',async()=>{
    db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1101').run();
    await expect(readOnly({selected_ids:[1101]})).rejects.toThrow(/AI_SOURCE_UNAVAILABLE/);
  });
  it('reports missing mapping and uses the actual manual override when present',async()=>{
    let result=await readOnly({selected_ids:[1102]});
    expect(finding(result,'epg_mapping_missing')).toMatchObject({certainty:'proven',value:1});
    expect(diagnostic(result,902).epg_mapping).toEqual({configured:false,origin:null,epg_channel_id:null});
    db.prepare("INSERT INTO epg_channel_mappings(provider_channel_id,epg_channel_id) VALUES(902,'manual-news')").run();
    result=await readOnly({selected_ids:[1102]});
    expect(diagnostic(result,902).epg_mapping).toEqual({configured:true,origin:'manual',epg_channel_id:'manual-news'});
    expect(finding(result,'epg_mapping_missing').value).toBe(0);
  });
  it('applies HDHomeRun live/enabled and M3U cached-series filters locally',async()=>{
    let result=await readOnly({selected_ids:[1102,1104,1105]});
    expect(diagnostic(result,902).local_export_filters).toMatchObject({account_catalog:true,m3u_playlist:true,hdhr_lineup:true});
    expect(diagnostic(result,904).local_export_filters).toMatchObject({account_catalog:true,m3u_playlist:true,hdhr_lineup:false});
    expect(diagnostic(result,905).local_export_filters).toMatchObject({account_catalog:true,m3u_playlist:false,hdhr_lineup:false,series_episodes_cached:false});
    db.prepare('UPDATE users SET hdhr_enabled=0 WHERE id=701').run();
    result=await readOnly({selected_ids:[1102]});
    expect(diagnostic(result,902).local_export_filters).toMatchObject({hdhr_enabled:false,hdhr_lineup:false});
  });
  it('observes cached series episodes without creating export aliases',async()=>{
    db.prepare("INSERT INTO provider_series_episodes(source_key,series_remote_id,remote_episode_id) VALUES('https://secret.invalid:443/user/pass',5,42)").run();
    const result=await readOnly({selected_ids:[1105]});
    expect(diagnostic(result,905).local_export_filters).toMatchObject({m3u_playlist:true,series_episodes_cached:true,hdhr_lineup:false});
    expect(db.prepare('SELECT COUNT(*) AS n FROM series_episode_aliases').get().n).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret.invalid');
  });
  it('reports an owned unassigned channel as excluded from account exports',async()=>{
    db.prepare('DELETE FROM user_channels WHERE id=1104').run();
    const result=await readOnly({channel_ids:[904]});
    expect(diagnostic(result,904)).toMatchObject({assigned:false,user_channel_id:null,category_id:null,
      local_export_filters:{account_catalog:false,m3u_playlist:false,hdhr_lineup:false}});
  });
  it('counts distinct fresh local user sessions without touching stale or foreign session rows',async()=>{
    const now=Date.now();
    const insert=db.prepare('INSERT INTO current_streams(id,user_id,username,channel_name,start_time,last_activity,ip,worker_pid,provider_id) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const [id,userId,name,ip,age] of [['first',701,'Visible news','192.0.2.1',0],['socket',701,'Visible news','192.0.2.1',0],['second',701,'A movie','192.0.2.1',0],['stale',701,'Old stream','192.0.2.2',86400000],['foreign',702,'Foreign private stream','198.51.100.1',0]]) insert.run(id,userId,'private username',name,now-age,now-age,ip,process.pid,801);
    const before=db.prepare('SELECT * FROM current_streams ORDER BY id').all();
    const result=await readOnly({selected_ids:[1102]});
    expect(finding(result,'local_user_connections')).toMatchObject({certainty:'proven',value:{active_sessions:2,configured_limit:2,limit_reached:true,stale_records_ignored:1,backend:'sqlite'}});
    expect(finding(result,'new_connection_may_be_blocked')).toMatchObject({certainty:'possible'});
    expect(db.prepare('SELECT * FROM current_streams ORDER BY id').all()).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/192\.0\.2|198\.51\.100|private username|Foreign private stream/);
  });
  it('reads Redis session evidence without cleaning up stale sessions or writing indexes',async()=>{
    const now=Date.now(),records={};
    for(const [id,userId,age] of [['first',701,0],['duplicate',701,0],['stale',701,86400000],['foreign',702,0]]) records[id]=JSON.stringify({id,user_id:userId,channel_name:age?'Old':'Visible news',ip:'192.0.2.1',provider_id:801,start_time:now-age,last_activity:now-age,worker_pid:process.pid});
    const before={...records};let writes=0;
    streamManager.redis={hGetAll:async()=>({...records}),hGet:async(key,id)=>records[id],
      hDel:async(key,id)=>{writes++;delete records[id];},eval:async()=>{writes++;},hSet:async()=>{writes++;}};
    const result=await readOnly({selected_ids:[1102]});
    expect(finding(result,'local_user_connections')).toMatchObject({certainty:'proven',value:{backend:'redis',active_sessions:1,stale_records_ignored:1,limit_reached:false}});
    expect(records).toEqual(before);expect(writes).toBe(0);
    expect(JSON.stringify(result)).not.toContain('192.0.2.1');
  });
  it('reports missing session telemetry as unknown instead of an empty count',async()=>{
    streamManager.redis={hGetAll:async()=>{throw new Error('Redis unavailable');}};
    const result=await readOnly({selected_ids:[1102]});
    expect(finding(result,'local_user_connections')).toMatchObject({certainty:'unknown',reason:'session_store_unavailable'});
    expect(finding(result,'local_user_connections')).not.toHaveProperty('value.active_sessions');
    expect(diagnostic(result,902)).toMatchObject({assigned:true});
  });
  it('retains deterministic technical evidence during an AI outage and identifies unimplemented telemetry',async()=>{
    const result=await readOnly({selected_ids:[1102]}, {infer:async()=>{throw new Error('AI offline');}});
    expect(result.explanation_unavailable).toBe(true);
    expect(diagnostic(result,902)).toMatchObject({assigned:true,epg_mapping:{configured:false}});
    for(const code of ['stream_reachability','protocol_export_delivery','client_share_filters','epg_program_delivery','upstream_connection_limits','playback_health','selected_session_identity']) expect(finding(result,code)).toMatchObject({certainty:'unknown'});
  });
});
