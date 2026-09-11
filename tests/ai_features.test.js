import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-domain-'));
process.env.DATA_DIR = dataDir;
let db, epg, executeFeature, authorizeResult, getConversation, getEnrichment;
const user = { id: 701, is_admin: false, username: 'one', provider_access: 0 };
const other = { id: 702, is_admin: false, username: 'two', provider_access: 0 };
const infer = data => async () => ({ data, model: 'synthetic', usage: {} });

beforeAll(async () => {
  ({ default: db } = await import('../src/database/db.js'));
  (await import('../src/database/db.js')).initDb(true);
  ({ default: epg } = await import('../src/database/epgDb.js'));
  (await import('../src/database/epgDb.js')).initEpgDb();
  ({ executeFeature, authorizeResult } = await import('../src/services/ai/features.js'));
  ({ getConversation, getEnrichment } = await import('../src/services/ai/library.js'));
});

beforeEach(() => {
  for (const table of ['ai_enrichments','ai_conversations','ai_proposals','ai_changes','ai_rules','ai_sync_snapshots','ai_preferences','epg_channel_mappings','user_channels','user_categories','provider_channels','providers','users']) db.prepare(`DELETE FROM ${table}`).run();
  epg.exec('DELETE FROM epg_programs; DELETE FROM epg_channels');
  db.exec(`INSERT INTO users(id,username,password) VALUES (701,'one','x'),(702,'two','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES (801,'First','https://secret.invalid/user/pass','secret','password',701),(802,'Second','https://other.invalid','other','password',702);
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,epg_channel_id,plot,genre) VALUES
      (901,801,1,'DE | News HD','live','news','A factual description','News'),
      (902,801,2,'DE | News SD','live','news','Another description','News'),
      (903,802,3,'Private channel','live','private','Other user private text','News');
    INSERT INTO user_categories(id,user_id,name) VALUES (1001,701,'My list'),(1002,702,'Private list');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,sort_order,assignment_origin) VALUES (1101,1001,901,0,'mapping'),(1102,1001,902,1,'manual'),(1103,1002,903,0,'manual');`);
  db.prepare("INSERT INTO settings(key,value) VALUES('ai_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({enabled:true,allowed_user_ids:[701],functions:['list','cleanup','duplicates','epg','sync']}));
  db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES(?,?)').run('user:701',JSON.stringify({enabled:true}));
});
afterAll(() => { epg?.close(); db?.close(); fs.rmSync(dataDir, {recursive:true,force:true}); });

describe('authorized AI features', () => {
  it.each([
    ['list',['create_category','rename_category','assign_channel','rename_channel','hide_channel','reorder_channel']],
    ['cleanup',['rename_category','rename_channel','hide_channel','reorder_channel']],
    ['duplicates',['hide_channel']],
    ['epg',['epg_mapping']],
    ['sync',['create_category','assign_channel','rename_channel']]
  ])('sends a %s schema that accepts only that feature actions',async(feature,allowed)=>{
    const {validateJson}=await import('../src/services/ai/transport.js');
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('schema-sync',701,801,JSON.stringify({complete:true,changes:[]}),Date.now());
    let schema;
    await executeFeature(user,{feature,selected_ids:[1101]},{infer:async request=>{schema=request.schema;return {data:{summary:'Review',actions:[]},model:'test'};}});
    for(const action of [
      {type:'create_category',key:'sports',name:'Sports',category_type:'live'},
      {type:'rename_category',category_id:1001,value:'Live'},
      {type:'assign_channel',provider_channel_id:901,category_id:1001},
      {type:'assign_channel',provider_channel_id:901,category_key:'sports'},
      {type:'rename_channel',user_channel_id:1101,value:'News'},
      {type:'hide_channel',user_channel_id:1101,value:true},
      {type:'reorder_channel',user_channel_id:1101,value:2},
      {type:'epg_mapping',provider_channel_id:901,epg_channel_id:'news',source_type:'provider',source_id:801}
    ]) expect(validateJson({summary:'Review',actions:[action]},schema),action.type).toBe(allowed.includes(action.type));
  });
  it.each(['list','cleanup'])('rejects EPG actions returned for %s while EPG AI is disabled',async(feature)=>{
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    db.prepare("UPDATE settings SET value=json_set(value,'$.functions',json('[\"list\",\"cleanup\"]')) WHERE key='ai_policy'").run();
    await expect(executeFeature(user,{feature},{infer:infer({summary:'Mapping',actions:[
      {type:'epg_mapping',provider_channel_id:901,epg_channel_id:'news',source_type:'provider',source_id:801}
    ]})})).rejects.toThrow(/AI_INVALID_ACTION/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM epg_channel_mappings').get().n).toBe(0);
  });
  it.each([['list',false],['list',true],['cleanup',false],['cleanup',true]])('rejects every persisted %s action before direct Apply, including EPG selected=%s',async(feature,selectEpg)=>{
    const {createProposal,applyProposal}=await import('../src/services/ai/proposals.js');
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    const epgResult=await executeFeature(user,{feature:'epg',channel_ids:[901],selected_ids:[1101]},{infer:infer({summary:'Possible match',actions:[
      {type:'epg_mapping',provider_channel_id:901,epg_channel_id:'news',source_type:'provider',source_id:801}
    ]})});
    const stored=JSON.parse(db.prepare('SELECT data_json FROM ai_proposals WHERE id=?').get(epgResult.proposal_id).data_json);
    const proposal=createProposal(user,{feature},[{type:'rename_channel',user_channel_id:1101,value:'News'}]);
    const mixed=JSON.parse(db.prepare('SELECT data_json FROM ai_proposals WHERE id=?').get(proposal.id).data_json);
    mixed.actions.push(stored.actions[0]);
    // Reproduce a pre-fix mixed proposal independently of creation validation.
    db.prepare('UPDATE ai_proposals SET data_json=? WHERE id=?').run(JSON.stringify(mixed),proposal.id);
    db.prepare("UPDATE settings SET value=json_set(value,'$.functions',json('[\"list\",\"cleanup\"]')) WHERE key='ai_policy'").run();
    const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
    const actionIds=(selectEpg?mixed.actions:proposal.actions).map(action=>action.id);
    expect(()=>applyProposal(user,proposal.id,{action_ids:actionIds,idempotency_key:'old-mixed-proposal'})).toThrow(/AI_INVALID_ACTION/);
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM epg_channel_mappings').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
    expect(db.prepare('SELECT status FROM ai_proposals WHERE id=?').get(proposal.id).status).toBe('pending');
  });
  it('only transmits own safe current candidates and invalidates a revoked result', async () => {
    let sent;
    const result = await executeFeature(user,{feature:'list',prompt:'Organize'}, {infer:async request => { sent=JSON.stringify(request); return {data:{summary:'Ready',actions:[]},model:'synthetic'}; }});
    expect(sent).toContain('DE | News');
    expect(sent).not.toContain('Private channel');
    expect(sent).not.toContain('secret.invalid');
    expect(() => authorizeResult(other,{feature:'list'},result)).toThrow();
    db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1101').run();
    expect(() => authorizeResult(user,{feature:'list'},result)).toThrow();
  });
  it('executes search filters locally and preserves only intended followup changes', async () => {
    const result = await executeFeature(user,{feature:'search',prompt:'News'}, {infer:infer({filters:{query:'News',type:'live'},summary:'News'})});
    expect(result.items.map(x=>x.provider_channel_id)).toEqual([901,902]);
    const followup = await executeFeature(user,{feature:'search',conversation_id:result.conversation_id,prompt:'under an hour'}, {infer:infer({filters:{max_duration:60},summary:'Short'})});
    expect(followup.filters).toMatchObject({query:'News',type:'live',max_duration:60});
    expect(followup.items).toEqual([]);
    expect(() => getConversation(other,result.conversation_id)).toThrow();
    db.prepare('UPDATE user_channels SET is_hidden=1 WHERE id=1101').run();
    expect(() => getConversation(user,result.conversation_id)).toThrow();
  });
  it('stores source hashed text without replacing originals, and invalidates source changes', async () => {
    const result = await executeFeature(user,{feature:'text',provider_channel_id:901,language:'de',operation:'translate'}, {infer:infer({text:'Eine sachliche Beschreibung',tags:[]})});
    expect(getEnrichment(user,result.enrichment_id).text).toBe('Eine sachliche Beschreibung');
    expect(db.prepare('SELECT plot FROM provider_channels WHERE id=901').get().plot).toBe('A factual description');
    expect(() => getEnrichment(other,result.enrichment_id)).toThrow();
    db.prepare("UPDATE provider_channels SET plot='Changed' WHERE id=901").run();
    expect(() => getEnrichment(user,result.enrichment_id)).toThrow();
  });
  it('keeps deterministic diagnostic evidence available when inference fails', async () => {
    const result = await executeFeature(user,{feature:'diagnose'}, {infer:async()=>{throw new Error('Offline');}});
    expect(result.findings.some(x=>x.code==='visible_channels' && x.value===2 && x.certainty==='proven')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Private channel');
  });
  it('does not invent unavailable EPG candidates or sync history', async () => {
    const result = await executeFeature(user,{feature:'epg'}, {infer:infer({summary:'No candidates',actions:[]})});
    expect(result.findings.some(x=>x.code==='epg_sources_missing')).toBe(true);
    const sync = await executeFeature(user,{feature:'sync'}, {infer:infer({summary:'Ignored',actions:[]})});
    expect(sync.diff).toBeNull();
    expect(sync.findings[0].code).toBe('sync_history_unavailable');
  });
  it('uses real EPG programs, language and timezone and rejects expired source evidence',async()=>{
    const now=Math.floor(Date.now()/1000);
    epg.prepare("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,?)").run(now);
    epg.prepare("INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES('news','provider',801,?,?, 'News documentary','Factual documentary','de')").run(now+60,now+3600);
    const result=await executeFeature(user,{feature:'search',timezone:'Europe/Berlin'}, {infer:infer({summary:'Documentaries',filters:{type:'program',language:'de',start:new Date((now+1)*1000).toISOString(),end:new Date((now+4000)*1000).toISOString()}})});
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({start:now+60,stop:now+3600,language:'de',timezone:'Europe/Berlin',title:'News documentary'});
    epg.prepare('UPDATE epg_programs SET stop=?').run(now-1);
    expect(()=>authorizeResult(user,{feature:'search'},result)).toThrow(/AI_STALE_SOURCE/);
  });
  it('permits only locally selected EPG identities and protects manual mappings',async()=>{
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    const invalid={type:'epg_mapping',provider_channel_id:901,epg_channel_id:'invented',source_type:'provider',source_id:801};
    await expect(executeFeature(user,{feature:'epg'}, {infer:infer({summary:'Guess',actions:[invalid]})})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    const valid={...invalid,epg_channel_id:'news'};
    const result=await executeFeature(user,{feature:'epg'}, {infer:infer({summary:'Possible match',actions:[valid]})});
    expect(result.proposal_id).toBeTruthy();
    db.prepare("INSERT INTO epg_channel_mappings(provider_channel_id,epg_channel_id) VALUES(901,'news')").run();
    expect(()=>authorizeResult(user,{feature:'epg'},result)).toThrow();
  });
  it('reports deterministic successful sync counts and rejects incomplete snapshots',async()=>{
    const change={kind:'renamed',provider_channel_id:901,user_channel_id:1101,before:{name:'Old',category_id:1001,category_name:'My list',stream_type:'live'},after:{name:'DE | News HD',category_id:1001,category_name:'My list',stream_type:'live'}};
    const data={complete:true,changes:[change],counts:{renamed:999},timestamp:Date.now()};
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)').run('snapshot',701,801,JSON.stringify(data),Date.now());
    const result=await executeFeature(user,{feature:'sync'}, {infer:infer({summary:'One rename',actions:[]})});
    expect(result.diff.counts).toEqual({added:0,removed:0,renamed:1,reassigned:0});
    db.prepare('UPDATE ai_sync_snapshots SET data_json=?').run(JSON.stringify({...data,complete:false}));
    expect(()=>authorizeResult(user,{feature:'sync'},result)).toThrow();
    const unavailable=await executeFeature(user,{feature:'sync'}, {infer:async()=>{throw new Error('Should not run');}});
    expect(unavailable.diff).toBeNull();
  });
  it.each([0,1000])('counts all 1500 authorized sync changes with %i revoked changes before the preview',async(revokedPrefix)=>{
    const insertChannel=db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)');
    const insertAssignment=db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id,authorization_revoked) VALUES(?,1001,?,?)');
    const changes=[];
    db.transaction(()=>{
      for(let i=0;i<1500+revokedPrefix;i++) {
        const id=2000+i,revoked=i<revokedPrefix,name=revoked?`Revoked ${i}`:`Authorized ${i}`;
        insertChannel.run(id,id,name);insertAssignment.run(10000+i,id,Number(revoked));
        const fields={category_id:1001,category_name:'My list',stream_type:'live'};
        changes.push({kind:'renamed',provider_channel_id:id,user_channel_id:10000+i,
          before:{...fields,name:`Old ${name}`},after:{...fields,name}});
      }
    })();
    const foreign={kind:'renamed',provider_channel_id:903,user_channel_id:1103,
      before:{name:'Private before'},after:{name:'Private channel'}};
    changes.unshift(foreign);changes.push(foreign);
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('large-sync',701,801,JSON.stringify({complete:true,changes,counts:{renamed:9999}}),Date.now());
    let sent;
    const result=await executeFeature(user,{feature:'sync',channel_ids:[901]},{infer:async request=>{
      sent=JSON.parse(request.messages[1].content);
      expect(JSON.stringify(request.messages).length).toBeLessThanOrEqual(64000);
      return {data:{summary:'1500 authorized renames',actions:[]},model:'synthetic'};
    }});
    for(const diff of [sent.diff,result.diff]) {
      expect(diff.counts).toEqual({added:0,removed:0,renamed:1500,reassigned:0});
      expect(diff.complete).toBe(true);
      expect(diff.changes).toHaveLength(20);
      expect(diff.preview).toEqual({total:1500,shown:20,partial:true});
      expect(diff.changes[0].provider_channel_id).toBe(2000+revokedPrefix);
    }
    expect(JSON.stringify([sent,result])).not.toMatch(/Private|Revoked/);
  });
  it.each(['inference','read'])('invalidates sync evidence revoked beyond the preview during %s',async(phase)=>{
    const changes=[];
    db.transaction(()=>{
      for(let i=0;i<21;i++) {
        db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)').run(2000+i,2000+i,`Channel ${i}`);
        db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(?,1001,?)').run(4000+i,2000+i);
        changes.push({kind:'renamed',provider_channel_id:2000+i,user_channel_id:4000+i,
          before:{name:`Old ${i}`},after:{name:`Channel ${i}`}});
      }
    })();
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('revoke-sync',701,801,JSON.stringify({complete:true,changes}),Date.now());
    const revoke=()=>db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=4020').run();
    const payload={feature:'sync',channel_ids:[901]};
    const generate=()=>executeFeature(user,payload,{infer:async()=>{
      if(phase==='inference') revoke();
      return {data:{summary:'21 renames',actions:[{type:'rename_channel',user_channel_id:1101,value:'News'}]},model:'synthetic'};
    }});
    if(phase==='inference') {
      await expect(generate()).rejects.toThrow(/AI_STALE_SOURCE/);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
    } else {
      const result=await generate();
      expect(result.diff.counts.renamed).toBe(21);
      expect(result.diff.changes).toHaveLength(20);
      revoke();
      expect(()=>authorizeResult(user,payload,JSON.parse(JSON.stringify(result)))).toThrow(/AI_STALE_SOURCE/);
    }
  });
  it('retains historical sync removals only while the provider remains authorized',async()=>{
    const changes=[{kind:'removed',provider_channel_id:2000,user_channel_id:4000,
      before:{name:'Removed channel',category_id:1001,category_name:'My list',stream_type:'live'},after:null}];
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('removed-sync',701,801,JSON.stringify({complete:true,changes}),Date.now());
    const result=await executeFeature(user,{feature:'sync'}, {infer:infer({summary:'One removal',actions:[]})});
    expect(result.diff.counts).toEqual({added:0,removed:1,renamed:0,reassigned:0});
    expect(result.diff.changes).toEqual(changes);
    db.prepare('UPDATE providers SET user_id=702 WHERE id=801').run();
    expect(()=>authorizeResult(user,{feature:'sync'},result)).toThrow(/AI_SOURCE_UNAVAILABLE/);
  });
  it('finds duplicate representatives across pages and honestly reports partial final pages',async()=>{
    db.prepare("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type) VALUES(904,801,4,'Other','live')").run();
    const result=await executeFeature(user,{feature:'duplicates',offset:1}, {infer:infer({summary:'Variants',actions:[]})});
    expect(result.coverage).toMatchObject({offset:1,partial:true,next_offset:null});
    expect(result.findings.some(group=>group.count===2 && group.representative?.provider_channel_id===901)).toBe(true);
  });
  it('never transmits hidden rows for search even when explicitly selected',async()=>{
    db.prepare('UPDATE user_channels SET is_hidden=1 WHERE id=1101').run();
    const result=await executeFeature(user,{feature:'search',selected_ids:[1101]}, {infer:infer({summary:'Visible',filters:{}})});
    expect(result.items.map(item=>item.provider_channel_id)).toEqual([902]);
  });
  it('does not store a late model result after cancellation',async()=>{
    const abort=new AbortController();
    await expect(executeFeature(user,{feature:'text',provider_channel_id:901},{signal:abort.signal,infer:async()=>{abort.abort();return {data:{text:'Late',tags:[]},model:'test'};}})).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_enrichments').get().n).toBe(0);
  });
  it('supports aggregate admin diagnosis without opening another users catalog',async()=>{
    db.prepare("INSERT OR REPLACE INTO admin_users(id,username,password,is_active) VALUES(799,'ai-admin','x',1)").run();
    const actor={id:799,is_admin:true};
    let transmitted;
    const result=await executeFeature(actor,{feature:'diagnose'},{infer:async request=>{transmitted=JSON.stringify(request);return {data:{summary:'Two users'},model:'test'};}});
    expect(result.findings.find(item=>item.code==='users').value).toBe(2);
    expect(transmitted).not.toContain('Private channel');
    expect(transmitted).not.toContain('password');
    expect(()=>authorizeResult(user,{feature:'diagnose'},result)).toThrow();
    db.prepare('UPDATE admin_users SET is_active=0 WHERE id=799').run();
    expect(()=>authorizeResult(actor,{feature:'diagnose'},result)).toThrow();
  });
  it('processes a complete list beyond the default page in bounded model batches',async()=>{
    const insert=db.prepare("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)");
    db.transaction(()=>{for(let i=0;i<250;i++) insert.run(2000+i,2000+i,`Catalog ${i}`);})();
    const seen=[];
    const result=await executeFeature(user,{feature:'list',full_list:true},{infer:async request=>{
      const batch=JSON.parse(request.messages[1].content).items;
      expect(batch.length).toBeLessThanOrEqual(80);
      seen.push(...batch.map(item=>item.provider_channel_id));
      return {data:{summary:'Reviewed',actions:[]},model:'test'};
    }});
    expect(result.coverage).toMatchObject({processed:252,total:252,partial:false,next_offset:null});
    expect(new Set(seen).size).toBe(252);
  });
  it.each([
    ['list',{type:'assign_channel',provider_channel_id:901,category_id:2020}],
    ['cleanup',{type:'rename_category',category_id:2020,value:'Reviewed category'}]
  ])('rejects an owned category omitted from the %s request and permits it when supplied',async(feature,action)=>{
    const {getProposal}=await import('../src/services/ai/proposals.js');
    db.transaction(()=>{
      for(let i=0;i<21;i++) db.prepare('INSERT INTO user_categories(id,user_id,name) VALUES(?,701,?)').run(2000+i,`Category ${i}`);
    })();
    await expect(executeFeature(user,{feature,channel_ids:[901]},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      expect(data.categories.map(category=>category.id)).not.toContain(2020);
      return {data:{summary:'Edit categories',actions:[{type:'rename_channel',user_channel_id:1101,value:'News'},action]},model:'test'};
    }})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
    db.prepare('UPDATE user_categories SET sort_order=-1 WHERE id=2020').run();
    const result=await executeFeature(user,{feature,channel_ids:[901]},{infer:async request=>{
      expect(JSON.parse(request.messages[1].content).categories.map(category=>category.id)).toContain(2020);
      return {data:{summary:'Edit supplied category',actions:[action]},model:'test'};
    }});
    expect(getProposal(user,result.proposal_id).actions).toEqual([expect.objectContaining({type:action.type,category_id:2020})]);
    expect(()=>getProposal(other,result.proposal_id)).toThrow(/AI_NOT_FOUND/);
    db.prepare("UPDATE user_categories SET name='Changed category' WHERE id=2020").run();
    expect(()=>getProposal(user,result.proposal_id)).toThrow(/AI_STALE_PROPOSAL/);
  });
  it('rejects a category supplied only to an earlier batch without persisting its earlier actions',async()=>{
    db.transaction(()=>{
      for(let i=0;i<21;i++) db.prepare('INSERT INTO user_categories(id,user_id,name) VALUES(?,701,?)').run(2000+i,`Category ${i}`);
      db.prepare('UPDATE user_channels SET user_category_id=2020 WHERE id=1101').run();
      for(let i=0;i<80;i++) db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)').run(2000+i,2000+i,`Channel ${i}`);
    })();
    let calls=0;
    await expect(executeFeature(user,{feature:'cleanup',full_list:true},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      expect(data.items.length).toBeLessThanOrEqual(80);
      expect(JSON.stringify(request.messages).length).toBeLessThanOrEqual(64000);
      const first=++calls===1;
      if(first) expect(data.categories.map(category=>category.id)).toContain(2020);
      else expect(data.categories.map(category=>category.id)).not.toContain(2020);
      return {data:{summary:'Review batch',actions:[first?{type:'rename_channel',user_channel_id:1101,value:'News'}:
        {type:'rename_category',category_id:2020,value:'Outside current batch'}]},model:'test'};
    }})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    expect(calls).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });
  it('preserves new-category dependencies and planned-category reuse across list batches',async()=>{
    const {getProposal}=await import('../src/services/ai/proposals.js');
    db.transaction(()=>{
      for(let i=0;i<80;i++) db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)').run(2000+i,2000+i,`Channel ${i}`);
    })();
    const created={type:'create_category',key:'news',name:'News',category_type:'live'};
    let calls=0;
    const result=await executeFeature(user,{feature:'list',full_list:true},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content),first=++calls===1;
      if(!first) expect(data.planned_categories).toEqual([created]);
      return {data:{summary:'Organize news',actions:[...(first?[created]:[]),
        {type:'assign_channel',provider_channel_id:data.items[0].provider_channel_id,category_key:'news'}]},model:'test'};
    }});
    const proposal=getProposal(user,result.proposal_id);
    expect(calls).toBe(2);
    expect(proposal.actions).toHaveLength(3);
    expect(proposal.actions[0]).toMatchObject({type:'create_category',after:{name:'News'}});
    for(const action of proposal.actions.slice(1)) expect(action).toMatchObject({type:'assign_channel',dependencies:[proposal.actions[0].id]});
  });
  it.each([
    ['provider channel',{type:'assign_channel',provider_channel_id:2079,category_id:1001}],
    ['user channel',{type:'rename_channel',user_channel_id:4079,value:'Outside current candidates'}],
    ['category',{type:'assign_channel',provider_channel_id:901,category_id:2020}]
  ])('rejects a sync %s omitted from the supplied current candidates',async(kind,action)=>{
    db.transaction(()=>{
      db.prepare("INSERT INTO user_categories(id,user_id,name) VALUES(2020,701,'Unsent category')").run();
      for(let i=0;i<80;i++) {
        db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(?,801,?,?)').run(2000+i,2000+i,`Channel ${i}`);
        db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(?,?,?)').run(4000+i,i===79?2020:1001,2000+i);
      }
    })();
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('candidate-sync',701,801,JSON.stringify({complete:true,changes:[]}),Date.now());
    await expect(executeFeature(user,{feature:'sync'},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      expect(data.candidates).toHaveLength(80);
      expect(data.candidates.some(item=>item.provider_channel_id===2079||item.user_channel_id===4079||item.category_id===2020)).toBe(false);
      return {data:{summary:'Review sync',actions:[{type:'rename_channel',user_channel_id:1101,value:'News'},action]},model:'test'};
    }})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });
  it('permits supplied sync IDs and a new-category dependency',async()=>{
    const {getProposal}=await import('../src/services/ai/proposals.js');
    db.prepare('INSERT INTO ai_sync_snapshots(id,user_id,provider_id,data_json,created_at) VALUES(?,?,?,?,?)')
      .run('candidate-sync',701,801,JSON.stringify({complete:true,changes:[]}),Date.now());
    const result=await executeFeature(user,{feature:'sync'},{infer:infer({summary:'Review current candidates',actions:[
      {type:'assign_channel',provider_channel_id:901,category_id:1001},
      {type:'rename_channel',user_channel_id:1102,value:'News SD'},
      {type:'create_category',key:'news',name:'News',category_type:'live'},
      {type:'assign_channel',provider_channel_id:902,category_key:'news'}
    ]})});
    const proposal=getProposal(user,result.proposal_id);
    expect(proposal.actions).toHaveLength(4);
    expect(proposal.actions[0]).toMatchObject({type:'assign_channel',provider_channel_id:901,category_id:1001});
    expect(proposal.actions[1]).toMatchObject({type:'rename_channel',user_channel_id:1102});
    expect(proposal.actions[3]).toMatchObject({type:'assign_channel',provider_channel_id:902,dependencies:[proposal.actions[2].id]});
  });
  it('rejects an EPG mapping omitted from the supplied review cases',async()=>{
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    db.transaction(()=>{
      for(let i=0;i<80;i++) {
        db.prepare("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,epg_channel_id) VALUES(?,801,?,'News','news')").run(2000+i,2000+i);
        db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(?,1001,?)').run(4000+i,2000+i);
      }
    })();
    await expect(executeFeature(user,{feature:'epg'},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      expect(data.cases).toHaveLength(80);
      expect(data.cases.some(item=>item.provider_channel_id===2079)).toBe(false);
      return {data:{summary:'Review EPG',actions:[{type:'epg_mapping',provider_channel_id:2079,epg_channel_id:'news',source_type:'provider',source_id:801}]},model:'test'};
    }})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM epg_channel_mappings').get().n).toBe(0);
  });
  it('checks source revocation again after inference before storing proposals',async()=>{
    await expect(executeFeature(user,{feature:'cleanup'},{infer:async()=>{
      db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1101').run();
      return {data:{summary:'Rename',actions:[{type:'rename_channel',user_channel_id:1101,value:'News'}]},model:'test'};
    }})).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });
  it('uses strict nested object schemas for feature requests',async()=>{
    const visit=schema=>{
      if(schema.type==='object') {expect(schema.additionalProperties).toBe(false);expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());Object.values(schema.properties).forEach(visit);}
      if(schema.items) visit(schema.items);
      schema.anyOf?.forEach(visit);
    };
    await executeFeature(user,{feature:'list'},{infer:async request=>{visit(request.schema);return {data:{summary:'Ready',actions:[]},model:'test'};}});
    await executeFeature(user,{feature:'search'},{infer:async request=>{visit(request.schema);return {data:{summary:'Found',filters:{}},model:'test'};}});
  });
  it('keeps a 2000-row metadata-rich full analysis within job and transport limits',async()=>{
    db.exec('DELETE FROM user_channels; DELETE FROM provider_channels');
    const insert=db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,plot,genre,epg_channel_id) VALUES(?,801,?,?,?,?,?)');
    db.transaction(()=>{for(let i=0;i<2000;i++) insert.run(2000+i,2000+i,`Channel ${i} ${'International '.repeat(14)}`.slice(0,200),'Description '.repeat(100),'Documentary '.repeat(10),'guide.'.repeat(34).slice(0,200));})();
    let calls=0,maxMessages=0;
    const result=await executeFeature(user,{feature:'list',full_list:true},{infer:async request=>{
      calls++;maxMessages=Math.max(maxMessages,JSON.stringify(request.messages).length);
      expect(JSON.stringify(request.messages).length).toBeLessThanOrEqual(64000);
      return {data:{summary:'Reviewed',actions:[]},model:'test'};
    }});
    expect(calls).toBe(25);
    expect(result.coverage).toMatchObject({processed:2000,total:2000,partial:false});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512000);
    expect(result.coverage.items_total).toBe(2000);
    expect(result.coverage.items_preview_partial).toBe(true);
    process.stdout.write(`AI full-list envelope ${JSON.stringify({calls,maxMessages,result:JSON.stringify(result).length})}\n`);
    db.prepare("UPDATE provider_channels SET name='Changed unseen item' WHERE id=3999").run();
    expect(()=>authorizeResult(user,{feature:'list'},JSON.parse(JSON.stringify(result)))).toThrow();
  },30000);
  it('rejects changed EPG program evidence in a stored mapping result',async()=>{
    const now=Math.floor(Date.now()/1000);
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    epg.prepare("INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES('news','provider',801,?,?,'Current news','Description','de')").run(now,now+3600);
    const result=await executeFeature(user,{feature:'epg'}, {infer:infer({summary:'Evidence',actions:[]})});
    epg.prepare("UPDATE epg_programs SET title='Replacement show'").run();
    expect(()=>authorizeResult(user,{feature:'epg'},result)).toThrow(/AI_STALE_SOURCE/);
  });
  it.each(['program','catalog'])('rejects stale %s evidence on direct EPG proposal reads and confirmation',async(kind)=>{
    const {getProposal,applyProposal}=await import('../src/services/ai/proposals.js');
    const now=Math.floor(Date.now()/1000);
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    epg.prepare("INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES('news','provider',801,?,?,'Future news','Description','de')").run(now+60,now+3600);
    const result=await executeFeature(user,{feature:'epg',channel_ids:[901],selected_ids:[1101]}, {infer:infer({summary:'Future news supports this mapping',actions:[{type:'epg_mapping',provider_channel_id:901,epg_channel_id:'news',source_type:'provider',source_id:801}]})});
    const proposal=getProposal(user,result.proposal_id);
    if(kind==='program') epg.exec('DELETE FROM epg_programs');
    else epg.exec("UPDATE epg_channels SET name='Changed source'");
    expect(()=>getProposal(user,result.proposal_id)).toThrow(/AI_STALE_SOURCE/);
    expect(()=>applyProposal(user,result.proposal_id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'stale-epg'})).toThrow(/AI_STALE_SOURCE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM epg_channel_mappings').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
  });
  it('keeps applied EPG evidence readable after its own write and allows conditional undo after program expiry',async()=>{
    const {getProposal,applyProposal,getChange,undoChange}=await import('../src/services/ai/proposals.js');
    const now=Math.floor(Date.now()/1000);
    epg.exec("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('news','News','provider',801,1)");
    epg.prepare("INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES('news','provider',801,?,?,'Future news','Description','de')").run(now+60,now+3600);
    const result=await executeFeature(user,{feature:'epg',channel_ids:[901],selected_ids:[1101]}, {infer:infer({summary:'Future news supports this mapping',actions:[{type:'epg_mapping',provider_channel_id:901,epg_channel_id:'news',source_type:'provider',source_id:801}]})});
    const proposal=getProposal(user,result.proposal_id);
    const change=applyProposal(user,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'fresh-epg'});
    expect(getProposal(user,proposal.id).status).toBe('applied');
    epg.exec('DELETE FROM epg_programs');
    expect(()=>getProposal(user,proposal.id)).toThrow(/AI_STALE_SOURCE/);
    expect(getChange(user,change.change_id).status).toBe('applied');
    expect(undoChange(user,change.change_id).status).toBe('undone');
    expect(db.prepare('SELECT COUNT(*) AS n FROM epg_channel_mappings').get().n).toBe(0);
  });
  it('bounds the maximum 6000 authorization references and metadata-heavy duplicate preview',async()=>{
    const {compactFeatureResult}=await import('../src/services/ai/features.js');
    const {hash}=await import('../src/services/ai/context.js');
    const refs=Array.from({length:6000},(_,i)=>({channel_id:Number.MAX_SAFE_INTEGER-i,assignment_id:Number.MAX_SAFE_INTEGER-6000-i,editing:true,allow_hidden:false,hash:hash(i)}));
    const text=(size)=>'"\\語'.repeat(size).slice(0,size);
    const item={provider_channel_id:Number.MAX_SAFE_INTEGER,user_channel_id:Number.MAX_SAFE_INTEGER,category_id:Number.MAX_SAFE_INTEGER,
      provider_id:Number.MAX_SAFE_INTEGER,name:text(200),original_name:text(200),category:text(160),genre:text(120),description:text(1000),epg_channel_id:text(200),type:'live',sort_order:1000000};
    const result=compactFeatureResult({feature:'duplicates',summary:text(2000),coverage:{processed:2000,total:2000,partial:false},items:Array(2000).fill(item),
      findings:Array.from({length:4000},(_,i)=>({id:i,count:2,representative:item,provider_channel_ids:[Number.MAX_SAFE_INTEGER-i],classification:'possible_duplicate'})),
      proposal_id:'all-actions-retained-in-proposal',_authorization:{owner_key:'user:701',user_id:701,refs}});
    expect(result._authorization.refs).toHaveLength(6000);
    expect(result._authorization.refs_hash).toBe(hash(refs.map(ref=>ref.hash)));
    expect(result._authorization.refs[5999]).toEqual([refs[5999].channel_id,refs[5999].assignment_id,1]);
    expect(result.proposal_id).toBe('all-actions-retained-in-proposal');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512000);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512000);
    process.stdout.write(`AI maximum-reference envelope ${JSON.stringify({references:result._authorization.refs.length,characters:JSON.stringify(result).length,bytes:Buffer.byteLength(JSON.stringify(result))})}\n`);
  });
  it('keeps escaped maximum labels and 500 categories below the real model message limit',async()=>{
    db.exec('DELETE FROM user_channels; DELETE FROM provider_channels');
    const text=(size)=>'"\\語'.repeat(size).slice(0,size);
    db.prepare('UPDATE user_categories SET name=? WHERE id=1001').run(text(160));
    const insert=db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,plot,genre) VALUES(?,801,?,?,?,?)');
    db.transaction(()=>{for(let i=0;i<80;i++) insert.run(2000+i,2000+i,text(200),text(1000),text(120));
      for(let i=0;i<499;i++) db.prepare('INSERT INTO user_categories(id,user_id,name) VALUES(?,701,?)').run(5000+i,text(160));})();
    let count=0,maxMessages=0;
    const result=await executeFeature(user,{feature:'list',full_list:true,prompt:text(2000)},{infer:async request=>{
      const content=JSON.parse(request.messages[1].content);count+=content.items.length;
      maxMessages=Math.max(maxMessages,JSON.stringify(request.messages).length);
      expect(JSON.stringify(request.messages).length).toBeLessThanOrEqual(64000);
      return {data:{summary:'Reviewed',actions:[]},model:'test'};
    }});
    expect(count).toBe(80);expect(result.coverage.partial).toBe(false);
    process.stdout.write(`AI maximum-metadata message ${maxMessages}\n`);
  });
});
