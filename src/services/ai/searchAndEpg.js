import epgDb from '../../database/epgDb.js';
import { createHash } from 'node:crypto';
import { ChannelMatcher } from '../channelMatcher.js';
import { allowedEpgChannels, verifyEpg, safeText, fail, hash } from './context.js';

export function timezoneName(value='UTC') {
  try { return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone; }
  catch { fail('AI_INVALID_TIMEZONE'); }
}
export function validateFilters(input,previous={}) {
  if(!input || typeof input!=='object'||Array.isArray(input)) fail('AI_INVALID_FILTERS');
  const allowed=['query','type','genre','language','region','start','end','max_duration','interests'];
  const filters={...previous};
  for(const [key,value] of Object.entries(input)) {
    if(!allowed.includes(key)) fail('AI_INVALID_FILTERS');
    if(value===null||value==='') {delete filters[key];continue;}
    if(key==='max_duration') {if(!Number.isFinite(value)||value<=0||value>1440) fail('AI_INVALID_FILTERS');filters[key]=value;continue;}
    if(key==='interests') {if(!Array.isArray(value)||value.length>8||value.some(x=>typeof x!=='string'||x.length>80)) fail('AI_INVALID_FILTERS');filters[key]=value.map(x=>safeText(x,80));continue;}
    if(typeof value!=='string'||value.length>200) fail('AI_INVALID_FILTERS');
    if(key==='type' && !['live','movie','series','program'].includes(value)) fail('AI_INVALID_FILTERS');
    if(['start','end'].includes(key) && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))) fail('AI_INVALID_FILTERS');
    filters[key]=safeText(value,200);
  }
  if(filters.start && filters.end && Date.parse(filters.end)<=Date.parse(filters.start)) fail('AI_INVALID_FILTERS');
  if(filters.start && filters.end && Date.parse(filters.end)-Date.parse(filters.start)>14*86400000) fail('AI_TIME_RANGE_TOO_LARGE');
  return filters;
}
function matches(item,filters) {
  if(filters.type && filters.type!=='program' && item.type!==filters.type) return false;
  for(const key of ['language','region','genre']) if(filters[key] && (!item[key] || !String(item[key]).toLowerCase().includes(filters[key].toLowerCase()))) return false;
  if(filters.max_duration && (item.duration===null || item.duration>filters.max_duration)) return false;
  const text=[item.name,item.title,item.description,item.genre].filter(Boolean).join(' ').toLowerCase();
  if(filters.query && !text.includes(filters.query.toLowerCase())) return false;
  if(filters.interests?.length && !filters.interests.some(interest=>text.includes(interest.toLowerCase()))) return false;
  return true;
}
export function searchLocally(actor,context,filters,timezone) {
  const programSearch=filters.type==='program'||Boolean(filters.start||filters.end);
  if(!programSearch) return {items:context.items.filter(item=>matches(item,filters)).slice(0,100),program_refs:[],truncated:context.items.filter(item=>matches(item,filters)).length>100};
  const now=Date.now()/1000,start=Math.max(filters.start?Date.parse(filters.start)/1000:now,now),end=filters.end?Date.parse(filters.end)/1000:start+86400;
  const epgChannels=allowedEpgChannels(actor,context.userId),items=[],program_refs=[];
  let seen=0;
  for(const channel of context.items) {
    if(channel.type!=='live') continue;
    for(const source of epgChannels.filter(source=>source.id===channel.epg_channel_id)) {
      // The primary key makes start unique within this exact channel/source partition.
      let cursor=null;
      while(true) {
        const limited=items.length>=100||seen>=5000,limit=limited?1:Math.min(100,5000-seen);
        // Once capped, only probe for omitted rows so an exact final page stays complete.
        const programs=epgDb.prepare(`SELECT ${limited?'1':'channel_id,source_type,source_id,start,stop,title,desc,lang'} FROM epg_programs
          WHERE channel_id=? AND source_type=? AND source_id=? AND stop>? AND start<? ${cursor===null?'':'AND start>?'} ORDER BY start LIMIT ?`)
          .all(source.id,source.source_type,source.source_id,start,end,...(cursor===null?[]:[cursor]),limit);
        if(!programs.length) break;
        if(limited) return {items,program_refs,truncated:true};
        for(const program of programs) {
          if(items.length>=100) return {items,program_refs,truncated:true};
          seen++;
          const item={...channel,title:safeText(program.title,200),description:safeText(program.desc,1000),language:program.lang||null,
            duration:(program.stop-program.start)/60,start:program.start,stop:program.stop,
            local_start:new Intl.DateTimeFormat('en-GB',{timeZone:timezone,dateStyle:'short',timeStyle:'short'}).format(new Date(program.start*1000)),
            timezone,program:{channel_id:program.channel_id,source_type:program.source_type,source_id:program.source_id,start:program.start}};
          if(matches(item,filters)) {items.push(item);program_refs.push({...item.program,hash:hash(program)});}
        }
        cursor=programs.at(-1).start;
        if(programs.length<limit) break;
      }
    }
  }
  // ponytail: capped source catalogs stay partial; add catalog lookahead if exact cap detection is needed.
  return {items,program_refs,truncated:epgChannels.length===5000};
}
export function verifyPrograms(actor,userId,refs) {
  for(const ref of refs||[]) {
    verifyEpg(actor,userId,{...ref,id:ref.channel_id});
    const row=epgDb.prepare('SELECT channel_id,source_type,source_id,start,stop,title,desc,lang FROM epg_programs WHERE channel_id=? AND source_type=? AND source_id=? AND start=?').get(ref.channel_id,ref.source_type,ref.source_id,ref.start);
    if(!row||row.stop<=Date.now()/1000||hash(row)!==ref.hash) fail('AI_STALE_SOURCE',409);
  }
}
function programCatalog(channels,asOf,collect=false) {
  const digest=createHash('sha256'),programs=new Map();
  let expiresAt=null;
  for(const source of channels) {
    const key=JSON.stringify([source.id,source.source_type,source.source_id]);
    const rows=epgDb.prepare('SELECT channel_id,source_type,source_id,start,stop,title,desc,lang FROM epg_programs WHERE channel_id=? AND source_type=? AND source_id=? AND stop>? ORDER BY start LIMIT 2')
      .all(source.id,source.source_type,source.source_id,asOf);
    digest.update(hash([key,rows]));
    for(const row of rows) expiresAt=expiresAt===null?row.stop:Math.min(expiresAt,row.stop);
    if(collect) programs.set(key,rows);
  }
  return {hash:digest.digest('hex'),expires_at:expiresAt,as_of:asOf,programs};
}
export function verifyEpgProgramCatalog(actor,userId,evidence) {
  if(!evidence) return;
  if(evidence.expires_at!==null && evidence.expires_at<=Date.now()/1000) fail('AI_STALE_SOURCE',409);
  if(programCatalog(allowedEpgChannels(actor,userId),evidence.as_of).hash!==evidence.hash) fail('AI_STALE_SOURCE',409);
}
export function epgEvidence(actor,context,payload) {
  const channels=allowedEpgChannels(actor,context.userId);
  const catalog=programCatalog(channels,Math.floor(Date.now()/1000),true);
  const programEvidence={hash:catalog.hash,as_of:catalog.as_of,expires_at:catalog.expires_at};
  if(!channels.length) return {findings:[{code:'epg_sources_missing',certainty:'proven'}],cases:[],catalog_hash:hash(channels),program_evidence:programEvidence,coverage:{epg_candidates:0,epg_partial:false}};
  const matcher=new ChannelMatcher(channels),cases=[];
  for(const channel of context.items.filter(row=>row.type==='live')) {
    const best=matcher.match(channel.original_name,channel.epg_channel_id);
    const selected=(payload.selected_ids||[]).includes(channel.user_channel_id);
    const suggestions=matcher.suggest(channel.original_name,channel.epg_channel_id,5).filter(item=>item.epgChannel);
    const candidates=suggestions.map(item=>{
      const source=item.epgChannel;
      const programs=catalog.programs.get(JSON.stringify([source.id,source.source_type,source.source_id]));
      return {id:source.id,name:safeText(source.name,200),source_type:source.source_type,source_id:source.source_id,
        match_method:item.method,match_score:item.confidence,programs:programs.map(p=>({start:p.start,stop:p.stop,title:safeText(p.title,200)}))};
    });
    const hasPrograms=candidates.some(candidate=>candidate.id===channel.epg_channel_id&&candidate.programs.length);
    const status=channel.manual_epg&&!selected?'manual_mapping_protected':best.confidence>=0.9&&hasPrograms?'local_match':candidates.length?'ambiguous':'no_match';
    cases.push({provider_channel_id:channel.provider_channel_id,user_channel_id:channel.user_channel_id,name:channel.name,current_epg_id:channel.epg_channel_id,status,
      program_gap:Boolean(channel.epg_channel_id&&!hasPrograms),candidates});
  }
  return {cases,catalog_hash:hash(channels),program_evidence:programEvidence,findings:cases.map(item=>({code:item.status,provider_channel_id:item.provider_channel_id,certainty:item.status==='local_match'?'proven':'unknown',program_gap:item.program_gap})),coverage:{epg_candidates:channels.length,epg_partial:channels.length===5000}};
}
