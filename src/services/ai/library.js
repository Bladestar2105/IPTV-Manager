import { randomUUID } from 'node:crypto';
import db from '../../database/db.js';
import { clearChannelsCache } from '../cacheService.js';
import { requireAiFeatureAccess } from './connections.js';
import { ownerKey, targetUser, ids, safeText, fail, checkReferences, sourceDescription, RETENTION_MS, prunePrivateRecords } from './context.js';

function owned(table,actor,id) {
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_key=?`).get(id,ownerKey(actor));
  if(!row) fail('AI_NOT_FOUND',404);
  targetUser(actor,row.user_id);
  return {...row,data:JSON.parse(row.data_json)};
}
function ruleText(rule,text) {
  if(rule.exceptions.some(exception=>text.includes(exception))) return text;
  if(rule.operation==='strip_prefix') return text.startsWith(rule.match)?text.slice(rule.match.length).trim():text;
  return text.split(rule.match).join(rule.replacement).trim();
}
function rulePreview(userId,rule) {
  return db.prepare(`SELECT uc.id,pc.name FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id=uc.user_category_id JOIN provider_channels pc ON pc.id=uc.provider_channel_id
    WHERE cat.user_id=? AND COALESCE(uc.custom_name,'')='' ORDER BY uc.id LIMIT 240`).all(userId)
    .map(row=>({user_channel_id:row.id,before:safeText(row.name,200),after:safeText(ruleText(rule,row.name),200)}))
    .filter(row=>row.after && row.before!==row.after);
}
export function listRules(actor,userId) {
  const target=targetUser(actor,userId);
  return db.prepare('SELECT * FROM ai_rules WHERE owner_key=? AND user_id=? ORDER BY created_at DESC LIMIT 100').all(ownerKey(actor),target)
    .map(row=>({id:row.id,...JSON.parse(row.data_json),enabled:Boolean(row.enabled)}));
}
export function saveRule(actor,input,id=null) {
  const existing=id?owned('ai_rules',actor,id):null;
  const value={...(existing?.data||{}),...input};
  const name=safeText(value.name,120).trim(),match=safeText(value.match,80),replacement=safeText(value.replacement||'',80);
  if(!name || !match || !['strip_prefix','replace_literal'].includes(value.operation)) fail('AI_INVALID_RULE');
  if(value.exceptions!==undefined && (!Array.isArray(value.exceptions)||value.exceptions.length>50||value.exceptions.some(x=>typeof x!=='string'||x.length>100))) fail('AI_INVALID_RULE');
  const data={name,operation:value.operation,match,replacement,exceptions:value.exceptions||[],proposal_id:value.proposal_id,action_id:value.action_id};
  // A stored transformation remains confirmed after its historical records expire.
  const unchanged=existing && ['operation','match','replacement','exceptions','proposal_id','action_id'].every(key=>JSON.stringify(data[key])===JSON.stringify(existing.data[key]));
  let userId=existing?.user_id;
  if(!unchanged) {
    const proposal=owned('ai_proposals',actor,value.proposal_id);
    if(proposal.updated_at<Date.now()-RETENTION_MS) fail('AI_NOT_FOUND',404);
    if(existing && existing.user_id!==proposal.user_id) fail('AI_INVALID_RULE');
    if(proposal.status!=='applied') fail('AI_RULE_REQUIRES_CONFIRMATION',409);
    const change=owned('ai_changes',actor,proposal.change_id);
    if(change.created_at<Date.now()-RETENTION_MS) fail('AI_NOT_FOUND',404);
    const action=proposal.data.actions.find(action=>action.id===value.action_id && action.type==='rename_channel');
    if(!action || !change.data.action_ids.includes(action.id)) fail('AI_RULE_REQUIRES_CONFIRMATION',409);
    const source=db.prepare('SELECT name FROM provider_channels WHERE id=?').get(action.provider_channel_id);
    if(!source || ruleText(data,source.name)!==action.after.custom_name) fail('AI_RULE_NOT_CONFIRMED',409);
    userId=proposal.user_id;
  }
  if(input.enabled!==undefined && typeof input.enabled!=='boolean') fail('AI_INVALID_RULE');
  const enabled=input.enabled??Boolean(existing?.enabled),ruleId=id||randomUUID(),now=Date.now();
  if(!existing && db.prepare('SELECT COUNT(*) AS n FROM ai_rules WHERE owner_key=?').get(ownerKey(actor)).n>=100) fail('AI_RULE_LIMIT',429);
  db.prepare(`INSERT INTO ai_rules(id,owner_key,user_id,data_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(ruleId,ownerKey(actor),userId,JSON.stringify(data),enabled?1:0,existing?.created_at||now,now);
  return {id:ruleId,...data,enabled,preview:rulePreview(userId,data)};
}
export function deleteRule(actor,id) {owned('ai_rules',actor,id);db.prepare('DELETE FROM ai_rules WHERE id=? AND owner_key=?').run(id,ownerKey(actor));return {deleted:true};}

export function saveConversation(actor,userId,filters,refs,id=null) {
  if(id) owned('ai_conversations',actor,id);
  const conversationId=id||randomUUID(),data={filters,refs};
  db.prepare(`INSERT INTO ai_conversations(id,owner_key,user_id,data_json,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at`).run(conversationId,ownerKey(actor),userId,JSON.stringify(data),Date.now());
  return conversationId;
}
export function getConversation(actor,id) {
  const row=owned('ai_conversations',actor,id);
  if(row.updated_at<Date.now()-RETENTION_MS) fail('AI_NOT_FOUND',404);
  checkReferences(actor,row.user_id,row.data.refs);
  return {id:row.id,user_id:row.user_id,filters:row.data.filters};
}
export function deleteConversation(actor,id) {owned('ai_conversations',actor,id);db.prepare('DELETE FROM ai_conversations WHERE id=? AND owner_key=?').run(id,ownerKey(actor));return {deleted:true};}
export function saveEnrichment(actor,userId,channelId,source,{text,tags,language,operation,model,program}) {
  const id=randomUUID(),data={text:safeText(text,6000),tags:tags.map(tag=>safeText(tag,60)),operation,program:program||null,refs:[source.reference],ai_generated:true};
  db.prepare(`INSERT INTO ai_enrichments(id,owner_key,user_id,provider_channel_id,source_hash,language,feature,model,prompt_version,data_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,ownerKey(actor),userId,channelId,source.source_hash,language,operation,model||'unknown','1',JSON.stringify(data),Date.now());
  return id;
}
export function getEnrichment(actor,id) {
  const row=owned('ai_enrichments',actor,id);
  if(row.created_at<Date.now()-RETENTION_MS) fail('AI_NOT_FOUND',404);
  checkReferences(actor,row.user_id,row.data.refs);
  const source=sourceDescription(actor,row.user_id,row.provider_channel_id,row.data.program);
  if(source.source_hash!==row.source_hash) fail('AI_STALE_SOURCE',409);
  return {id:row.id,provider_channel_id:row.provider_channel_id,source_hash:row.source_hash,language:row.language,model:row.model,prompt_version:row.prompt_version,created_at:row.created_at,
    text:row.data.text,tags:row.data.tags,operation:row.data.operation,ai_generated:true,original:source.text};
}

export function applyRulesAfterSync(userId,channelIds) {
  const selected=ids(channelIds,5000);
  if(!selected.length) return {applied:0};
  const rules=db.prepare('SELECT * FROM ai_rules WHERE user_id=? AND enabled=1 ORDER BY created_at,id LIMIT 100').all(userId);
  let applied=0;
  db.transaction(()=>{
    for(const row of rules) {
      const actor={id:Number(row.owner_key.split(':')[1]),is_admin:row.owner_key.startsWith('admin:')};
      try {
        requireAiFeatureAccess(actor,'cleanup');
        targetUser(actor,userId);
      } catch(error) {
        if(error.status===403) continue;
        throw error;
      }
      const rule=JSON.parse(row.data_json),diffs=[];
      for(const channelId of selected) {
        const channels=db.prepare(`SELECT uc.id,uc.custom_name,pc.name FROM authorized_user_channels uc
          JOIN user_categories cat ON cat.id=uc.user_category_id JOIN provider_channels pc ON pc.id=uc.provider_channel_id
          WHERE cat.user_id=? AND pc.id=? AND COALESCE(uc.custom_name,'')=''`).all(userId,channelId);
        for(const channel of channels) {
          const value=safeText(ruleText(rule,channel.name),200);
          if(!value || value===channel.name) continue;
          db.prepare('UPDATE user_channels SET custom_name=? WHERE id=? AND COALESCE(custom_name,\'\')=\'\'').run(value,channel.id);
          diffs.push({table:'user_channels',id:channel.id,provider_channel_id:channelId,before:{custom_name:channel.custom_name},after:{custom_name:value}});
          applied++;
        }
      }
      if(diffs.length) db.prepare('INSERT INTO ai_changes(id,owner_key,user_id,data_json,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(),row.owner_key,userId,JSON.stringify({rule_id:row.id,feature:'cleanup',diffs}),'applied',Date.now());
    }
    if(applied) prunePrivateRecords();
  })();
  if(applied) clearChannelsCache(userId);
  return {applied};
}
