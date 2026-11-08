import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-list-retrieval-'));
process.env.DATA_DIR=dataDir;
const user={id:701,is_admin:false,provider_access:0};
const other={id:702,is_admin:false,provider_access:0};
let db,executeFeature,getConversation,authorizeResult;
const request='Erstelle eine Liste "Fussball" mit allen relevanten Sendern in Live-TV. Lösche oder ändere keine anderen Listen!';
const football={type:'live',terms:['DAZN','Sky Bundesliga','Fussball'],language_terms:[]};

beforeAll(async()=>{
  const main=await import('../src/database/db.js');db=main.default;main.initDb(true);
  const guide=await import('../src/database/epgDb.js');guide.initEpgDb();
  ({executeFeature,authorizeResult}=await import('../src/services/ai/features.js'));
  ({getConversation}=await import('../src/services/ai/library.js'));
});
beforeEach(()=>{
  for(const table of ['ai_conversations','ai_proposals','ai_changes','ai_preferences','epg_channel_mappings','user_channels','user_categories','provider_channels','providers','users']) db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO users(id,username,password) VALUES(701,'one','x'),(702,'two','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES(801,'Own','https://secret.invalid','secret','secret',701),(802,'Other','https://foreign.invalid','secret','secret',702);
    INSERT INTO user_categories(id,user_id,name) VALUES(1001,701,'Existing'),(1002,702,'Private');`);
  db.prepare("INSERT INTO settings(key,value) VALUES('ai_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({enabled:true,allowed_user_ids:[701],functions:['list','search']}));
  db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES(?,?)').run('user:701',JSON.stringify({enabled:true}));
});
afterAll(async()=>{
  (await import('../src/database/epgDb.js')).default.close();db?.close();fs.rmSync(dataDir,{recursive:true,force:true});
});
function channel(id,name,{type='live',provider=801,genre=null,category=null,custom=null,revoked=0,grant=0}={}) {
  db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,genre) VALUES(?,?,?,?,?,?)').run(id,provider,id,name,type,genre);
  if(category) db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id,custom_name,authorization_revoked,granted_by_admin) VALUES(?,?,?,?,?,?)').run(10000+id,category,id,custom,revoked,grant);
}
function irrelevant(count) {db.transaction(()=>{for(let i=1;i<=count;i++) channel(i,`Unrelated ${i}`,{type:i%2?'movie':'live'});})();}
function model(selection,{review=()=>({summary:'Reviewed',actions:[]}),plans=[]}={}) {
  return async input=>{
    const data=JSON.parse(input.messages[1].content);
    expect(JSON.stringify(input.messages).length).toBeLessThanOrEqual(64000);
    if(!data.items) {plans.push(data);return {data:{selection},model:'fixture'};}
    expect(data.items.length).toBeLessThanOrEqual(80);
    return {data:review(data),model:'fixture'};
  };
}

describe('planned list retrieval',()=>{
  it('finds every late matching live variant before paging while preserving catalog authorization and preview/Undo',async()=>{
    irrelevant(2100);
    channel(3001,'DE | DAZN 1 HD');channel(3002,'DE | DAZN 1 FHD');channel(3003,'DE | Sky Bundesliga 2 UHD');
    channel(3004,'DAZN documentary',{type:'movie'});
    channel(3005,'DAZN private',{provider:802,category:1002});
    channel(3006,'DAZN revoked',{category:1001,revoked:1});
    channel(3007,'DAZN admin grant',{provider:802,category:1001,grant:1});
    const seen=[],plans=[];
    const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football,{plans,review:data=>{
      seen.push(...data.items.map(item=>item.provider_channel_id));
      return {summary:'Fussball',actions:[{type:'create_category',key:'football',name:'Fussball',category_type:'live'},...data.items.filter(item=>item.provider_channel_id!==3007).map(item=>({type:'assign_channel',provider_channel_id:item.provider_channel_id,category_key:'football'}))]};
    }})});
    expect(seen).toEqual([3001,3002,3003,3007]);
    expect(plans).toHaveLength(1);expect(JSON.stringify(plans)).not.toContain('Unrelated');expect(JSON.stringify(plans)).not.toContain('secret.invalid');
    expect(result).toMatchObject({list_request:request,selection:football,coverage:{processed:4,total:4,partial:false,next_offset:null,requires_narrowing:false,candidate_limit:240}});
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
    const {getProposal,applyProposal,undoChange}=await import('../src/services/ai/proposals.js');
    const proposal=getProposal(user,result.proposal_id);
    expect(proposal.actions).toHaveLength(4);
    const applied=applyProposal(user,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'planned-football'});
    expect(db.prepare('SELECT * FROM user_categories WHERE id IN(1001,1002) ORDER BY id').all().map(row=>row.name)).toEqual(['Existing','Private']);
    undoChange(user,applied.change_id);
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  });

  it('keeps original theme, destination and protections in immutable refinement snapshots and uses AND language clues',async()=>{
    channel(1,'DE | DAZN 1 HD',{category:1001});channel(2,'AL | DAZN 1 HD');channel(3,'DE | General News');
    const first=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    const plans=[],selection={...football,language_terms:['DE |','German']};
    const refined=await executeFeature(user,{feature:'list',prompt:'Meine nur deutschsprachige Sender!',conversation_id:first.conversation_id},{infer:model(selection,{plans})});
    expect(plans[0].list_request).toBe(request+'\nRefinement: Meine nur deutschsprachige Sender!');
    expect(plans[0].previous_selection).toEqual(football);
    expect(refined.list_request).toContain('Lösche oder ändere keine anderen Listen!');
    expect(refined.items.map(item=>item.provider_channel_id)).toEqual([1]);
    expect(refined.items[0].language).toBeNull();
    expect(refined.conversation_id).not.toBe(first.conversation_id);
    expect(getConversation(user,first.conversation_id).list.request).toBe(request);
    const another=await executeFeature(user,{feature:'list',prompt:'Nur HD',conversation_id:first.conversation_id},{infer:model(football)});
    expect(another.conversation_id).not.toBe(refined.conversation_id);
    expect(another.list_request).not.toContain('deutschsprachige');
  });

  it.each([[false,241,240],[true,2001,2000]])('stops before review inference when matches exceed the review budget (full=%s)',async(full,count,limit)=>{
    db.transaction(()=>{for(let i=1;i<=count;i++) channel(i,`DAZN ${i}`);})();
    let calls=0;
    const result=await executeFeature(user,{feature:'list',prompt:request,full_list:full,offset:80},{infer:async input=>{
      calls++;expect(JSON.parse(input.messages[1].content).items).toBeUndefined();return {data:{selection:football}};
    }});
    expect(calls).toBe(1);
    expect(result.coverage).toMatchObject({total:count,processed:0,offset:0,partial:true,next_offset:null,requires_narrowing:true,candidate_limit:limit});
    expect(result.items).toEqual([]);expect(result.proposal_id).toBeUndefined();expect(result.conversation_id).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });

  it.each([[80,false,2],[81,true,0]])('preflights %i matches against the remaining inference budget before review',async(count,narrowing,expectedReviews)=>{
    db.transaction(()=>{for(let i=1;i<=count;i++) channel(i,`DAZN ${i}`);})();
    let planned=false,reviews=0,budgetReads=0;
    const infer=model(football,{review:()=>{reviews++;return {summary:'Reviewed',actions:[]};}});
    const result=await executeFeature(user,{feature:'list',prompt:request,full_list:true},{
      remainingCalls:()=>{expect(planned).toBe(true);budgetReads++;return 2;},
      infer:async input=>{const reply=await infer(input);if(!JSON.parse(input.messages[1].content).items) planned=true;return reply;}
    });
    expect(budgetReads).toBe(1);expect(reviews).toBe(expectedReviews);
    expect(result.coverage).toMatchObject({processed:narrowing?0:count,total:count,candidate_limit:80,requires_narrowing:narrowing,next_offset:null});
  });

  it.each([[3,120,true],[19,240,false]])('distinguishes the configured review limit from %i remaining calls',async(calls,limit,budgetLimited)=>{
    db.transaction(()=>{for(let i=1;i<=694;i++) channel(i,`DAZN ${i}`);})();
    const result=await executeFeature(user,{feature:'list',prompt:request},{remainingCalls:()=>calls,infer:model(football,{review:()=>{throw new Error('The oversized set must not be reviewed');}})});
    expect(result.coverage).toMatchObject({total:694,processed:0,review_limit:240,expanded_candidate_limit:calls*40,candidate_limit:limit,budget_limited:budgetLimited,requires_narrowing:true,required_review_calls:18});
  });

  it('continues a cached list with explicit full review using the saved instruction and selection without a planner call',async()=>{
    db.transaction(()=>{for(let i=1;i<=241;i++) channel(i,`DAZN ${i}`);})();
    const first=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    expect(first.coverage.requires_narrowing).toBe(true);
    let reviews=0,seen=0;
    const continued=await executeFeature(user,{feature:'list',conversation_id:first.conversation_id,prompt:'',full_list:true},{remainingCalls:()=>7,infer:async input=>{
      const data=JSON.parse(input.messages[1].content);
      expect(data.items).toBeDefined();expect(data.prompt).toBe(request);reviews++;seen+=data.items.length;
      return {data:{summary:'Reviewed',actions:[]}};
    }});
    expect(reviews).toBe(7);expect(seen).toBe(241);
    expect(continued).toMatchObject({list_request:request,selection:football,coverage:{processed:241,total:241,review_limit:2000,candidate_limit:280,expanded_candidate_limit:280,budget_limited:false,requires_narrowing:false,required_review_calls:7}});
    expect(continued.conversation_id).not.toBe(first.conversation_id);
    expect(getConversation(user,first.conversation_id).list.request).toBe(request);
  });

  it('reevaluates an oversized cached continuation locally without any inference call',async()=>{
    db.transaction(()=>{for(let i=1;i<=241;i++) channel(i,`DAZN ${i}`);})();
    const first=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    channel(242,'DAZN 242');
    const continued=await executeFeature(user,{feature:'list',conversation_id:first.conversation_id,prompt:' ',full_list:true},{remainingCalls:()=>3,infer:async()=>{throw new Error('A cached oversized continuation must not infer');}});
    expect(continued.coverage).toMatchObject({processed:0,total:242,review_limit:2000,expanded_candidate_limit:120,candidate_limit:120,budget_limited:true,requires_narrowing:true});
    expect(continued.proposal_id).toBeUndefined();
  });

  it('revalidates cached continuation ownership, scope, references and stored selection without inference',async()=>{
    channel(1,'DAZN',{category:1001});
    const first=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    const payload={feature:'list',conversation_id:first.conversation_id,prompt:'',full_list:true};
    const options={infer:async()=>{throw new Error('Invalid cached state must not infer');}};
    await expect(executeFeature(other,payload,options)).rejects.toThrow(/AI_NOT_FOUND/);
    await expect(executeFeature(user,{...payload,category_id:1001},options)).rejects.toThrow(/AI_INVALID_CONVERSATION/);
    db.prepare("UPDATE provider_channels SET name='Changed DAZN' WHERE id=1").run();
    await expect(executeFeature(user,payload,options)).rejects.toThrow(/AI_STALE_SOURCE/);
    db.prepare("UPDATE provider_channels SET name='DAZN' WHERE id=1").run();
    db.prepare('UPDATE user_channels SET authorization_revoked=1').run();
    await expect(executeFeature(user,payload,options)).rejects.toThrow(/AI_SOURCE_UNAVAILABLE/);
    db.prepare('UPDATE user_channels SET authorization_revoked=0').run();
    db.prepare("UPDATE ai_conversations SET data_json=json_set(data_json,'$.list.selection.type','program') WHERE id=?").run(first.conversation_id);
    await expect(executeFeature(user,payload,options)).rejects.toThrow(/AI_INVALID_SELECTION/);
  });

  it('reviews a complete explicit full list in at most 40 records per request',async()=>{
    db.transaction(()=>{for(let i=1;i<=241;i++) channel(i,`DAZN ${i}`);})();
    let processed=0,reviews=0;
    const result=await executeFeature(user,{feature:'list',prompt:request,full_list:true},{infer:model(football,{review:data=>{reviews++;processed+=data.items.length;return {summary:'Reviewed',actions:[]};}})});
    expect(processed).toBe(241);expect(reviews).toBe(7);
    expect(result.coverage).toMatchObject({processed:241,total:241,partial:false,next_offset:null,requires_narrowing:false,candidate_limit:2000});
  });

  it('keeps every proposed assignment and its new category within the fixed output and action budget',async()=>{
    db.transaction(()=>{for(let i=1;i<=80;i++) channel(i,`DAZN ${i}`);})();
    const seen=[];
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football,{review:data=>{
      expect(data.items.length).toBeLessThanOrEqual(40);
      seen.push(...data.items.map(item=>item.provider_channel_id));
      return {summary:'Fussball',actions:[...(data.planned_categories.length?[]:[{type:'create_category',key:'football',name:'Fussball',category_type:'live'}]),...data.items.map(item=>({type:'assign_channel',provider_channel_id:item.provider_channel_id,category_key:'football'}))]};
    }})});
    expect(seen).toHaveLength(80);expect(new Set(seen).size).toBe(80);
    const {getProposal}=await import('../src/services/ai/proposals.js');
    const proposal=getProposal(user,result.proposal_id);
    expect(proposal.actions.filter(action=>action.type==='assign_channel')).toHaveLength(80);
    expect(proposal.actions.filter(action=>action.type==='create_category')).toHaveLength(1);
  });

  it('previews, applies and undoes all 2000 matching channels plus their new category',async()=>{
    db.transaction(()=>{for(let i=1;i<=2000;i++) channel(i,`DAZN ${i}`);})();
    let reviews=0;
    const result=await executeFeature(user,{feature:'list',prompt:request,full_list:true},{infer:model(football,{review:data=>{
      reviews++;
      return {summary:'Fussball',actions:[...(data.planned_categories.length?[]:[{type:'create_category',key:'football',name:'Fussball',category_type:'live'}]),...data.items.map(item=>({type:'assign_channel',provider_channel_id:item.provider_channel_id,category_key:'football'}))]};
    }})});
    expect(reviews).toBe(50);expect(result.coverage).toMatchObject({processed:2000,total:2000,partial:false});
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(512000);
    const {getProposal,applyProposal,undoChange}=await import('../src/services/ai/proposals.js');
    const proposal=getProposal(user,result.proposal_id);
    expect(proposal.actions).toHaveLength(2001);
    const applied=applyProposal(user,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'all-2000'});
    const destination=db.prepare("SELECT id FROM user_categories WHERE user_id=701 AND name='Fussball'").get();
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_channels WHERE user_category_id=?').get(destination.id).n).toBe(2000);
    expect(undoChange(user,applied.change_id).status).toBe('undone');
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_channels').get().n).toBe(0);
    expect(db.prepare('SELECT name FROM user_categories ORDER BY id').all().map(row=>row.name)).toEqual(['Existing','Private']);
  },30000);

  it('coalesces only identical channel destinations across candidate batches and preserves old lists',async()=>{
    db.exec("INSERT INTO user_categories(id,user_id,name) VALUES(1003,701,'Second existing')");
    db.transaction(()=>{for(let i=1;i<=39;i++) channel(i,`DAZN ${i}`);})();
    channel(40,'DAZN 40',{category:1001});
    db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(20040,1003,40)').run();
    const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
    const seen=[];
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football,{review:data=>{
      seen.push(data.items.length);
      return {summary:'Fussball',actions:[...(data.planned_categories.length?[]:[{type:'create_category',key:'football',name:'Fussball',category_type:'live'}]),...data.items.map(item=>({type:'assign_channel',provider_channel_id:item.provider_channel_id,category_key:'football'}))]};
    }})});
    expect(seen).toEqual([40,1]);expect(result.coverage.processed).toBe(41);
    const {getProposal,applyProposal,undoChange}=await import('../src/services/ai/proposals.js');
    const proposal=getProposal(user,result.proposal_id);
    expect(proposal.actions.filter(action=>action.type==='assign_channel')).toHaveLength(40);
    const applied=applyProposal(user,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'shared-source'});
    expect(db.prepare('SELECT * FROM user_channels WHERE user_category_id IN(1001,1003) ORDER BY id').all()).toEqual(before);
    undoChange(user,applied.change_id);
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  });

  it.each([['Österreich Sport','ÖSTERREICH'],['ΕΛΛΗΝΙΚΆ Αθλητικά','ελληνικά']])('matches Unicode case consistently for %s',async(name,term)=>{
    channel(1,name);channel(2,'Other Sport');
    const selection={type:'live',terms:[term],language_terms:[]};
    const result=await executeFeature(user,{feature:'list',prompt:'Make a regional sports list'},{infer:model(selection)});
    expect(result.items.map(item=>item.provider_channel_id)).toEqual([1]);
    expect(result.coverage.total).toBe(1);
  });

  it('routes generic conversation refinements to their stored list feature',async()=>{
    channel(1,'DAZN');
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    const jobs=await import('../src/services/ai/jobs.js');
    const create=vi.spyOn(jobs,'createJob').mockReturnValue({id:'queued-followup'});
    try {
      const {followup}=await import('../src/controllers/aiController.js');
      const response={set:vi.fn(),json:vi.fn(),status:vi.fn().mockReturnThis()};
      await followup({user,params:{id:result.conversation_id},body:{feature:'search',prompt:'German only'},get:()=>null},response);
      expect(create).toHaveBeenCalledWith(user,{feature:'list',prompt:'German only',user_id:701,conversation_id:result.conversation_id},undefined);
      expect(response.json).toHaveBeenCalledWith({id:'queued-followup'});
    } finally {create.mockRestore();}
  });

  it('returns honest zero matches without review inference or an empty category proposal',async()=>{
    channel(1,'Other');
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football,{review:()=>{throw new Error('No candidates should be reviewed');}})});
    expect(result.coverage).toMatchObject({processed:0,total:0,partial:false,requires_narrowing:false});
    expect(result.items).toEqual([]);expect(result.proposal_id).toBeUndefined();expect(result.summary).toBeTruthy();
  });

  it('matches custom names, categories and genre while keeping explicit category and channel scopes',async()=>{
    db.exec("INSERT INTO user_categories(id,user_id,name) VALUES(1003,701,'Fussball DE |')");
    channel(1,'Generic',{category:1001,custom:'DE | DAZN'});channel(2,'DE | Generic',{genre:'Fussball'});channel(3,'Generic',{category:1003});channel(4,'DE | DAZN');
    const selection={...football,language_terms:['DE |']};
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(selection)});
    expect(result.items.map(item=>item.provider_channel_id)).toEqual([1,2,3,4]);
    const scoped=await executeFeature(user,{feature:'list',prompt:request,category_id:1001,channel_ids:[1]},{infer:model(selection)});
    expect(scoped.items.map(item=>item.provider_channel_id)).toEqual([1]);
    await expect(executeFeature(user,{feature:'list',prompt:'German only',category_id:1003,conversation_id:scoped.conversation_id},{infer:model(selection)})).rejects.toThrow(/AI_INVALID_CONVERSATION/);
  });

  it.each(['%','_','.*',"' OR 1=1 --"])('uses model criteria as literal values: %s',async term=>{
    channel(1,'DAZN');channel(2,`Literal ${term} value`);
    const result=await executeFeature(user,{feature:'list',prompt:'Literal match'},{infer:model({type:'live',terms:[term],language_terms:[]})});
    expect(result.items.map(item=>item.provider_channel_id)).toEqual([2]);
  });

  it.each([
    {type:null,terms:[],language_terms:[]},
    {type:'program',terms:['DAZN'],language_terms:[]},
    {type:'live',terms:[''],language_terms:[]},
    {type:'live',terms:['x'.repeat(81)],language_terms:[]},
    {type:'live',terms:Array(17).fill('DAZN'),language_terms:[]},
    {type:'live',terms:['DAZN'],language_terms:[],sql:'1=1'},
  ])('rejects invalid or unbounded planner criteria %#',async selection=>{
    channel(1,'DAZN');
    await expect(executeFeature(user,{feature:'list',prompt:request},{infer:model(selection)})).rejects.toThrow(/AI_INVALID_SELECTION/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_conversations').get().n).toBe(0);
  });

  it('rejects cross-feature, cross-user, expired, changed and revoked conversation state before inference',async()=>{
    channel(1,'DE | DAZN',{category:1001});
    const result=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    const noInfer=async()=>{throw new Error('Unauthorized inference');};
    await expect(executeFeature(user,{feature:'search',conversation_id:result.conversation_id},{infer:noInfer})).rejects.toThrow(/AI_INVALID_CONVERSATION/);
    await expect(executeFeature(other,{feature:'list',prompt:'German',conversation_id:result.conversation_id},{infer:noInfer})).rejects.toThrow(/AI_NOT_FOUND/);
    await expect(executeFeature({id:1,is_admin:true},{feature:'list',user_id:702,prompt:'German',conversation_id:result.conversation_id},{infer:noInfer})).rejects.toThrow(/AI_NOT_FOUND/);
    db.prepare("UPDATE provider_channels SET name='Changed DAZN' WHERE id=1").run();
    await expect(executeFeature(user,{feature:'list',prompt:'German',conversation_id:result.conversation_id},{infer:noInfer})).rejects.toThrow(/AI_STALE_SOURCE/);
    db.prepare("UPDATE provider_channels SET name='DE | DAZN' WHERE id=1").run();
    db.prepare('UPDATE user_channels SET authorization_revoked=1').run();
    expect(()=>authorizeResult(user,{feature:'list'},result)).toThrow(/AI_SOURCE_UNAVAILABLE/);
    await expect(executeFeature(user,{feature:'list',prompt:'German',conversation_id:result.conversation_id},{infer:noInfer})).rejects.toThrow(/AI_SOURCE_UNAVAILABLE/);
    db.prepare('UPDATE ai_conversations SET updated_at=1').run();
    expect(()=>getConversation(user,result.conversation_id)).toThrow(/AI_NOT_FOUND/);
  });

  it('keeps untagged legacy conversations search-only and rejects an overlong refinement without inference',async()=>{
    channel(1,'DAZN',{category:1001});
    const search=await executeFeature(user,{feature:'search',prompt:'DAZN'},{infer:async()=>({data:{filters:{query:'DAZN'},summary:'Search'}})});
    const row=db.prepare('SELECT data_json FROM ai_conversations WHERE id=?').get(search.conversation_id),data=JSON.parse(row.data_json);delete data.feature;
    db.prepare('UPDATE ai_conversations SET data_json=? WHERE id=?').run(JSON.stringify(data),search.conversation_id);
    expect(getConversation(user,search.conversation_id).feature).toBe('search');
    await expect(executeFeature(user,{feature:'list',prompt:request,conversation_id:search.conversation_id},{infer:model(football)})).rejects.toThrow(/AI_INVALID_CONVERSATION/);
    const first=await executeFeature(user,{feature:'list',prompt:request},{infer:model(football)});
    await expect(executeFeature(user,{feature:'list',prompt:'x'.repeat(2000),conversation_id:first.conversation_id},{infer:async()=>{throw new Error('Should not infer');}})).rejects.toThrow(/AI_CONTEXT_TOO_LARGE/);
  });
});
