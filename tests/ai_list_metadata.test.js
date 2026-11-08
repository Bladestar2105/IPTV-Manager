import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-list-metadata-'));
process.env.DATA_DIR=dataDir;
const user={id:701,is_admin:false,provider_access:0};
const scope={category_id:null,channel_ids:[],selected_ids:[]};
const movieSelection={type:'movie',terms:[],language_terms:[]};
let db,context,selection;
beforeAll(async()=>{
  const main=await import('../src/database/db.js');db=main.default;main.initDb(true);
  context=await import('../src/services/ai/context.js');
  selection=await import('../src/services/ai/listSelection.js');
});
beforeEach(()=>{
  for(const table of ['ai_conversations','ai_proposals','ai_changes','epg_channel_mappings','user_channels','user_categories','provider_channels','providers','users']) db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO users(id,username,password) VALUES(701,'one','x'),(702,'two','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES(801,'Own','https://secret.invalid','secret','secret',701),(802,'Other','https://foreign.invalid','secret','secret',702);
    INSERT INTO user_categories(id,user_id,name,type) VALUES(1001,701,'DE - 80s','movie'),(1002,702,'Private','movie');`);
});
afterAll(()=>{db?.close();fs.rmSync(dataDir,{recursive:true,force:true});});
function movie(id,name,{releaseDate=null,rating=null,provider=801,category=null,revoked=0}={}) {
  db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type,releaseDate,rating) VALUES(?,?,?,?,?,?,?)').run(id,provider,id,name,'movie',releaseDate,rating);
  if(category) db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id,authorization_revoked) VALUES(?,?,?,?)').run(10000+id,category,id,revoked);
}
function retrieve(value=movieSelection,payload={},limit=Infinity) {
  return context.buildContext(user,{feature:'list',...payload},selection.validateListSelection(value,scope),limit);
}

describe('movie list retrieval evidence',()=>{
  it.each(['German','Deutsch','Germany','DE','DE |','DE:','[DE]','(DE)'])('expands %s without weakening theme, year or authorization filters',clue=>{
    movie(1,'DE - Terminator (1984)',{releaseDate:'1984-10-26',rating:'8.1',category:1001});
    movie(2,'DE| Terminator (1973)',{releaseDate:'1973-01-01',category:1001});
    movie(3,'DE: Terminator (1988)');
    movie(4,'DE - Unknown Terminator',{category:1001});
    movie(5,'DE - Terminator (1986)',{provider:802,category:1002});
    movie(6,'DE - Terminator (1985)',{category:1001,revoked:1});
    movie(7,'AL - Terminator (1984)');
    movie(8,'DE - Unrelated (1984)');
    movie(9,'Terminator (1983)',{category:1001});
    const result=retrieve({...movieSelection,terms:['Terminator'],language_terms:[clue],year_from:1980,year_to:1989},{},3);
    expect(result.items.map(item=>item.provider_channel_id)).toEqual([1,3,9]);
    expect(result.coverage).toMatchObject({total:3,requires_narrowing:false});
    expect(result.items[0]).toMatchObject({release_year:1984,year_source:'provider',provider_rating:8.1,rating_source:'provider',language:null});
    expect(result.items[1]).toMatchObject({release_year:1988,year_source:'title',provider_rating:null,rating_source:null});
    expect(retrieve({...movieSelection,language_terms:[clue],year_from:1980,year_to:1989},{category_id:1001,channel_ids:[1]}).items.map(item=>item.provider_channel_id)).toEqual([1]);
  });

  it('uses explicit year bounds without redundant decade terms blocking provider-dated movies',()=>{
    movie(1,'DE - Action film',{releaseDate:'1984-10-26'});
    movie(2,'DE - Comedy film',{releaseDate:'1986-01-01'});
    movie(3,'AL - Action film',{releaseDate:'1985-01-01'});
    movie(4,'DE - Action film (1984)',{releaseDate:'1973-01-01'});
    const terms=['1980','1981','1982','1983','1984','1985','1986','1987','1988','1989','80er','80s','eighties'];
    const planned={...movieSelection,terms,language_terms:['German'],year_from:1980,year_to:1989};
    expect(retrieve(planned).items.map(item=>item.provider_channel_id)).toEqual([1,2]);
    expect(retrieve({...planned,terms:[...terms,'Action']}).items.map(item=>item.provider_channel_id)).toEqual([1]);
  });

  it.each(['1970','70er','80s sequel','eighty','2080s'])('preserves nonredundant thematic clue %s',term=>{
    movie(1,'DE - Action film',{releaseDate:'1984-10-26'});
    expect(retrieve({...movieSelection,terms:[term],year_from:1980,year_to:1989}).coverage.total).toBe(0);
  });

  it('does not interpret unrelated language words as DE and preserves other languages',()=>{
    movie(1,'DE - Swedish movie');movie(2,'Swedish Decade');movie(3,'AL - Movie');
    expect(retrieve({...movieSelection,language_terms:['Swedish']}).items.map(item=>item.provider_channel_id)).toEqual([1,2]);
    expect(retrieve({...movieSelection,language_terms:['AL -']}).items.map(item=>item.provider_channel_id)).toEqual([3]);
    expect(retrieve({...movieSelection,language_terms:['DE']}).items.map(item=>item.provider_channel_id)).toEqual([1]);
  });

  it('accepts valid provider dates, falls back to one bounded title year and rejects ambiguous or unknown years',()=>{
    movie(1,'Film (1985)',{releaseDate:'1973-05-01'});
    movie(2,'Film (1985)',{releaseDate:'1985-02-30'});
    movie(3,'Film 1984 / 1985');movie(4,'Film x1985x');movie(5,'Film',{category:1001});
    movie(6,'Film (1986)',{releaseDate:'1986'});
    expect(retrieve({...movieSelection,year_from:1980,year_to:1989}).items.map(item=>item.provider_channel_id)).toEqual([2,6]);
    const items=retrieve().items;
    expect(items[0]).toMatchObject({release_year:1973,year_source:'provider'});
    expect(items[1]).toMatchObject({release_year:1985,year_source:'title'});
    for(const item of items.slice(2,5)) expect(item).toMatchObject({release_year:null,year_source:null});
  });

  it.each([['0',0],['10',10],['8.2',8.2],['-1',null],['10.1',null],['NaN',null],['',null],[null,null],['8/10',null]])('normalizes provider rating %s with provenance', (rating,want)=>{
    movie(1,'Film (1984)',{rating});
    expect(retrieve().items[0]).toMatchObject({provider_rating:want,rating_source:want===null?null:'provider'});
  });

  it('leaves old channel hashes and proposal evidence valid, but revokes new movie metadata evidence',async()=>{
    movie(1,'Film (1984)',{rating:'8',releaseDate:'1984-01-01'});
    const old=context.reference(context.channelRecord(user,701,1,{editing:true}),true);
    const {createProposal,getProposal}=await import('../src/services/ai/proposals.js');
    const proposal=createProposal(user,{user_id:701,feature:'list'},[{type:'create_category',key:'legacy',name:'Legacy',category_type:'movie'}],'',[old]);
    const current=retrieve().refs;
    expect(current[0].hash).toBe(old.hash);expect(current[0].metadata_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(()=>context.checkMetadataReferences(current)).not.toThrow();
    db.prepare("UPDATE provider_channels SET rating='9' WHERE id=1").run();
    expect(()=>context.checkReferences(user,701,[old])).not.toThrow();
    expect(()=>getProposal(user,proposal.id)).not.toThrow();
    expect(()=>context.checkReferences(user,701,current)).toThrow(/AI_STALE_SOURCE/);
    const changed=retrieve().refs;
    db.prepare("UPDATE provider_channels SET releaseDate='1985-01-01' WHERE id=1").run();
    expect(()=>context.checkMetadataReferences(changed)).toThrow(/AI_STALE_SOURCE/);
    db.prepare('DELETE FROM provider_channels WHERE id=1').run();
    expect(()=>context.checkMetadataReferences(changed)).toThrow(/AI_SOURCE_UNAVAILABLE/);
  });
});

describe('list plan validation',()=>{
  it('preserves legacy selections and normalizes nullable year fields away',()=>{
    expect(selection.validateListSelection(movieSelection,scope)).toEqual(movieSelection);
    expect(selection.validateListSelection({...movieSelection,year_from:null,year_to:null},scope)).toEqual(movieSelection);
    expect(selection.validateListSelection({...movieSelection,year_from:1980,year_to:1989},scope)).toMatchObject({year_from:1980,year_to:1989});
    expect(selection.validateListCategory(null,movieSelection)).toBeNull();
    expect(selection.validateListCategory(undefined,movieSelection)).toBeNull();
    expect(selection.validateListCategory({name:'  Eighties  ',type:'movie'},movieSelection)).toEqual({name:'Eighties',type:'movie'});
  });
  it.each([
    {year_from:1799,year_to:1989},{year_from:1980,year_to:2101},{year_from:1990,year_to:1980},
    {year_from:1980.5,year_to:1989},{year_from:'1980',year_to:1989},{year_from:1980},
    {year_from:1980,year_to:null},{type:'live',year_from:1980,year_to:1989},
  ])('rejects invalid year filters %#',patch=>{
    expect(()=>selection.validateListSelection({...movieSelection,...patch},scope)).toThrow(/AI_INVALID_SELECTION/);
  });
  it.each([{name:'',type:'movie'},{name:'x'.repeat(161),type:'movie'},{name:'https://secret.invalid',type:'movie'},
    {name:'Eighties',type:'live'},{name:'Eighties',type:'movie',extra:true},'Eighties',[]])('rejects unsafe or mismatched destinations %#',value=>{
    expect(()=>selection.validateListCategory(value,movieSelection)).toThrow(/AI_INVALID_SELECTION/);
  });
});
