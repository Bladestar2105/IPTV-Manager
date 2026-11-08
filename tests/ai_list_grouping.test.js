import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-list-grouping-'));
process.env.DATA_DIR=dataDir;
const actor={id:701,is_admin:false,provider_access:0};
const selection={type:'live',terms:['DAZN'],language_terms:[]};
const category={name:'Fussball',type:'live'};
let db,epg,executeFeature,authorizeResult,getProposal,applyProposal,undoChange;

beforeAll(async()=>{
  const main=await import('../src/database/db.js');db=main.default;main.initDb(true);
  const guide=await import('../src/database/epgDb.js');epg=guide.default;guide.initEpgDb();
  ({executeFeature,authorizeResult}=await import('../src/services/ai/features.js'));
  ({getProposal,applyProposal,undoChange}=await import('../src/services/ai/proposals.js'));
});
beforeEach(()=>{
  for(const table of ['ai_conversations','ai_proposals','ai_changes','ai_preferences','epg_channel_mappings','user_channels','user_categories','provider_channels','providers','users']) db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO users(id,username,password) VALUES(701,'one','x'),(702,'other','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES(801,'Own','https://secret.invalid','secret','secret',701),(802,'Other','https://foreign.invalid','secret','secret',702);
    INSERT INTO user_categories(id,user_id,name) VALUES(1001,701,'Existing'),(1002,701,'Second'),(1003,702,'Private');`);
  db.prepare("INSERT INTO settings(key,value) VALUES('ai_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({enabled:true,allowed_user_ids:[701],functions:['list']}));
  db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES(?,?)').run('user:701',JSON.stringify({enabled:true}));
});
afterAll(()=>{epg?.close();db?.close();fs.rmSync(dataDir,{recursive:true,force:true});});
function channels(count){db.transaction(()=>{for(let id=1;id<=count;id++) db.prepare("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type) VALUES(?,801,?,?,'live')").run(id,id,`DAZN ${id} HD`);})();}
const payload={feature:'list',prompt:'Erstelle eine neue Fussball-Liste. Bestehende Listen beibehalten.',language:'de'};
function inference({review=data=>data.items.map(item=>item.id),plans=[],batches=[]}={}){
  return async request=>{
    const data=JSON.parse(request.messages[1].content);
    if(!data.items){plans.push(data);return {data:{selection,new_category:category}};}
    batches.push(data);
    expect(request.schema.properties.selected_ids).toBeDefined();
    expect(request.schema.properties.actions).toBeUndefined();
    expect(data.now).toBeUndefined();
    expect(data.items.every(item=>Number.isSafeInteger(item.id))).toBe(true);
    expect(JSON.stringify(data)).not.toMatch(/secret\.invalid|foreign\.invalid|password|provider_id|sort_order|manual_name/);
    return {data:{selected_ids:review(data)}};
  };
}

describe('compact new thematic lists',()=>{
  it('reviews 161 candidates in three calls and builds a protected preview with working Apply and Undo',async()=>{
    channels(162);
    db.exec("INSERT INTO user_channels(id,user_category_id,provider_channel_id,custom_name,sort_order,is_hidden) VALUES(1101,1001,1,'Manual DAZN',0,1)");
    const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
    const batches=[];
    const result=await executeFeature(actor,{...payload,full_list:true,pinned_ids:[1101],keep_first:1},{remainingCalls:()=>3,infer:inference({batches,review:data=>data.items.filter(item=>item.id!==2).map(item=>item.id)})});
    expect(batches.map(batch=>batch.items.length)).toEqual([80,80,1]);
    expect(result.coverage).toMatchObject({processed:161,total:161,required_review_calls:3,candidate_limit:240,requires_narrowing:false});
    expect(result.summary.length).toBeLessThan(500);
    const proposal=getProposal(actor,result.proposal_id);
    expect(proposal.actions.filter(action=>action.type==='create_category').map(action=>action.after)).toEqual([expect.objectContaining({name:'Fussball',type:'live'})]);
    expect(proposal.actions.filter(action=>action.type==='assign_channel')).toHaveLength(160);
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
    const applied=applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'compact-list'});
    expect(db.prepare('SELECT * FROM user_channels WHERE id=1101').get()).toEqual(before[0]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_channels').get().n).toBe(161);
    undoChange(actor,applied.change_id);
    expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT name FROM user_categories ORDER BY id').all().map(row=>row.name)).toEqual(['Existing','Second','Private']);
  });

  it('reuses a saved category plan on explicit expanded review without a new planning call',async()=>{
    channels(241);
    const first=await executeFeature(actor,payload,{remainingCalls:()=>10,infer:inference()});
    expect(first.coverage).toMatchObject({processed:0,total:241,requires_narrowing:true,required_review_calls:4});
    const plans=[],batches=[];
    const result=await executeFeature(actor,{...payload,prompt:'',conversation_id:first.conversation_id,full_list:true},{remainingCalls:()=>4,infer:inference({plans,batches})});
    expect(plans).toEqual([]);expect(batches.map(batch=>batch.items.length)).toEqual([80,80,80,1]);
    expect(getProposal(actor,result.proposal_id).actions).toHaveLength(242);
  });

  it.each([[999],[1,1],['1'],null])('rejects untrusted selected IDs %j before a proposal can be saved',async ids=>{
    channels(1);
    await expect(executeFeature(actor,payload,{infer:inference({review:()=>ids})})).rejects.toThrow(/AI_INVALID_(?:CANDIDATE|RESPONSE)/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });

  it('rejects an ID belonging to another batch even when that channel is authorized',async()=>{
    channels(81);
    await expect(executeFeature(actor,payload,{infer:inference({review:()=>[81]})})).rejects.toThrow(/AI_INVALID_CANDIDATE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  });

  it('does not ask twice or assign twice for repeated appearances in existing lists',async()=>{
    channels(81);
    db.exec('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(1101,1001,1),(1102,1002,1)');
    const batches=[];
    const result=await executeFeature(actor,payload,{infer:inference({batches})});
    const ids=batches.flatMap(batch=>batch.items.map(item=>item.id));
    expect(ids).toHaveLength(81);expect(new Set(ids).size).toBe(81);
    expect(getProposal(actor,result.proposal_id).actions.filter(action=>action.type==='assign_channel')).toHaveLength(81);
  });

  it('keeps ordinary edit plans on the existing action schema',async()=>{
    channels(1);db.exec('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(1101,1001,1)');
    const result=await executeFeature(actor,{feature:'list',prompt:'Rename the selected channel',selected_ids:[1101]},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      if(!data.items)return {data:{selection,new_category:null}};
      expect(request.schema.properties.actions).toBeDefined();
      return {data:{summary:'Rename',actions:[{type:'rename_channel',user_channel_id:1101,value:'DAZN One'}]}};
    }});
    expect(getProposal(actor,result.proposal_id).actions.map(action=>action.type)).toEqual(['rename_channel']);
  });

  it.each([1,4])('preflights bounded messages with %i remaining calls before reviewing long catalog labels',async calls=>{
    channels(80);
    db.prepare('UPDATE provider_channels SET name=?,genre=?').run('DAZN '+'\\'.repeat(194),'"'.repeat(120));
    db.prepare('UPDATE user_categories SET name=? WHERE id=1001').run('"'.repeat(160));
    db.transaction(()=>{for(let id=1;id<=80;id++) db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id,custom_name) VALUES(?,1001,?,?)').run(11000+id,id,'DAZN '+'"'.repeat(194));})();
    db.prepare("UPDATE settings SET value=json_set(value,'$.system_prompt',?) WHERE key='ai_policy'").run('\\'.repeat(4000));
    const batches=[];
    const infer=inference({batches});
    const result=await executeFeature(actor,payload,{remainingCalls:()=>calls,infer:request=>{
      expect(JSON.stringify(request.messages).length).toBeLessThanOrEqual(64000);
      return infer(request);
    }});
    if(calls===1){
      expect(batches).toEqual([]);
      expect(result.coverage).toMatchObject({processed:0,total:80,requires_narrowing:true,budget_limited:true});
      expect(result.coverage.candidate_limit).toBeGreaterThan(0);expect(result.coverage.candidate_limit).toBeLessThan(80);
      expect(result.coverage.required_review_calls).toBeGreaterThan(1);
      expect(result.proposal_id).toBeUndefined();
    }else{
      expect(batches.flatMap(batch=>batch.items)).toHaveLength(80);
      expect(batches.length).toBeLessThanOrEqual(calls);
      expect(result.coverage).toMatchObject({processed:80,total:80,requires_narrowing:false,required_review_calls:batches.length});
      expect(getProposal(actor,result.proposal_id).actions).toHaveLength(81);
    }
  });

  it('retains movie metadata checks in compressed results and proposal Apply',async()=>{
    db.exec("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,rating,releaseDate) VALUES(1,801,1,'DE - Film (1984)','movie',8.2,'1984-01-01')");
    const result=await executeFeature(actor,{feature:'list',prompt:'New German 1980s films category'},{infer:async request=>{
      const data=JSON.parse(request.messages[1].content);
      if(!data.items)return {data:{selection:{type:'movie',terms:[],language_terms:['German'],year_from:1980,year_to:1989},new_category:{name:'Eighties',type:'movie'}}};
      expect(data.items[0]).toMatchObject({id:1,release_year:1984,provider_rating:8.2,rating_source:'provider'});
      return {data:{selected_ids:[1]}};
    }});
    const proposal=getProposal(actor,result.proposal_id);
    db.prepare('UPDATE provider_channels SET rating=1 WHERE id=1').run();
    expect(()=>authorizeResult(actor,{feature:'list'},result)).toThrow(/AI_STALE_SOURCE/);
    expect(()=>getProposal(actor,proposal.id)).toThrow(/AI_STALE_SOURCE/);
    expect(()=>applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'stale-rating'})).toThrow(/AI_STALE_SOURCE/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_channels').get().n).toBe(0);
  });

  it('authorizes mixed catalog results without treating absent live metadata as a stale movie',async()=>{
    channels(1);
    db.exec("INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,rating) VALUES(2,801,2,'Film (1984)','movie',8)");
    const result=await executeFeature(actor,{feature:'list',prompt:'Review both media types'},{infer:async request=>{
      if(!JSON.parse(request.messages[1].content).items)return {data:{selection:{type:null,terms:['DAZN','Film'],language_terms:[]},new_category:null}};
      return {data:{summary:'Reviewed',actions:[]}};
    }});
    expect(result.coverage.total).toBe(2);
    expect(()=>authorizeResult(actor,{feature:'list'},result)).not.toThrow();
    db.prepare('UPDATE provider_channels SET rating=2 WHERE id=2').run();
    expect(()=>authorizeResult(actor,{feature:'list'},result)).toThrow(/AI_STALE_SOURCE/);
  });
});
