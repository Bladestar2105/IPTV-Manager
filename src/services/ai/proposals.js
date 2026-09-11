import { randomUUID } from 'node:crypto';
import db from '../../database/db.js';
import { clearChannelsCache } from '../cacheService.js';
import { createCategory, addChannel } from '../userListWriteService.js';
import { isAdultCategory } from '../../utils/helpers.js';
import { ownerKey, targetUser, positiveId, ids, safeText, fail, hash, channelRecord, reference, checkReferences, verifyEpg, allowedEpgChannels, RETENTION_MS, MAX_CANDIDATES } from './context.js';
import { verifyEpgProgramCatalog } from './searchAndEpg.js';
import { requireAiFeatureAccess } from './connections.js';
import { validateFeatureActions } from './proposalContract.js';

const FIELDS = {rename_channel:'custom_name',hide_channel:'is_hidden',reorder_channel:'sort_order'};
const assignmentFields=['sort_order','is_hidden','assignment_origin','mapping_id','granted_by_admin','authorization_revoked'];
const pick=(row,fields)=>Object.fromEntries(fields.map(key=>[key,row[key]]));
const equal=(a,b)=>hash(a)===hash(b);
const normalName=name=>String(name).toLowerCase().replace(/\b(?:uhd|fhd|hd|sd|4k|8k|hevc|h264|h265)\b/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function category(userId,id) {
  const row=db.prepare('SELECT * FROM user_categories WHERE id=? AND user_id=?').get(positiveId(id),userId);
  if(!row) fail('AI_FORBIDDEN',403);
  return row;
}
function assignment(actor,userId,id,allowHidden=false) {
  const row=db.prepare('SELECT provider_channel_id FROM user_channels WHERE id=?').get(positiveId(id));
  if(!row) fail('AI_SOURCE_UNAVAILABLE',409);
  return channelRecord(actor,userId,row.provider_channel_id,{editing:true,assignmentId:id,allowHidden});
}
function permittedAdd(actor,userId,channelId) {
  const owner=db.prepare('SELECT p.user_id FROM provider_channels pc JOIN providers p ON p.id=pc.provider_id WHERE pc.id=?').get(channelId);
  // AI list editing never creates new cross-owner grants, including for an admin.
  if(!owner || owner.user_id!==userId) fail('AI_FORBIDDEN',403);
  return channelRecord(actor,userId,channelId,{editing:true,allowHidden:true});
}
function record(table,actor,id) {
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_key=?`).get(id,ownerKey(actor));
  if(!row || (row.updated_at??row.created_at)<Date.now()-RETENTION_MS) fail('AI_NOT_FOUND',404);
  targetUser(actor,row.user_id);
  return {...row,data:JSON.parse(row.data_json)};
}
function publicProposal(row) {
  return {id:row.id,status:row.status,feature:row.data.feature,summary:row.data.summary,change_id:row.change_id,
    actions:row.data.actions.map(({id,type,label,target_name,user_channel_id,provider_channel_id,category_id,before,after,dependencies})=>({id,type,label,target_name,user_channel_id,provider_channel_id,category_id,before:displayValues(before),after:displayValues(after),dependencies}))};
}
function displayValues(value) {return value?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'?safeText(item,6000):item])):value;}

export function createProposal(actor,payload,input,summary='',evidence=[],sourceEvidence=null) {
  const userId=targetUser(actor,payload.user_id);
  validateFeatureActions(payload.feature,input);
  const selected=new Set(ids(payload.selected_ids));
  const pinned=new Set(ids(payload.pinned_ids));
  const keepFirst=Number(payload.keep_first||0);
  if(!Number.isSafeInteger(keepFirst)||keepFirst<0||keepFirst>100000) fail('AI_INVALID_PROTECTION');
  const created=new Map(), seen=new Set(), sortCounts=new Map();
  const actions=[];
  for(const raw of input) {
    const action={id:randomUUID(),type:raw.type,label:safeText(raw.label||raw.type,200),dependencies:[],refs:[]};
    if(raw.type==='create_category') {
      const key=String(raw.key||'');
      const name=safeText(raw.name,160).trim(),type=raw.category_type||'live';
      if(!key||key.length>80||created.has(key)||!name||!['live','movie','series'].includes(type)) fail('AI_INVALID_ACTION');
      const max=db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS n FROM user_categories WHERE user_id=?').get(userId).n;
      action.before=null; action.after={name,type,is_adult:isAdultCategory(name)?1:0,sort_order:max+created.size+1};
      action.category_state=hash(db.prepare('SELECT * FROM user_categories WHERE user_id=? ORDER BY id').all(userId));
      created.set(key,action);
    } else if(raw.type==='rename_category') {
      const cat=category(userId,raw.category_id),name=safeText(raw.value,160).trim();
      if(!name) fail('AI_INVALID_ACTION');
      action.category_id=cat.id; action.category_hash=hash(cat);
      action.before={name:cat.name}; action.after={name};
      // An AI label must never alter the owner's explicit adult classification.
      action.protected_adult=cat.is_adult;
    } else if(raw.type==='assign_channel') {
      const channel=permittedAdd(actor,userId,positiveId(raw.provider_channel_id));
      action.provider_channel_id=channel.provider_channel_id;
      action.refs=[reference(channel,true,true)];
      let cat;
      if(raw.category_key) {
        const dependency=created.get(raw.category_key);
        if(!dependency) fail('AI_INVALID_DEPENDENCY');
        action.dependencies=[dependency.id]; action.category_action_id=dependency.id;
        cat={id:dependency.id,type:dependency.after.type};
      } else {
        cat=category(userId,raw.category_id); action.category_id=cat.id; action.category_hash=hash(cat);
      }
      if(cat.type!==channel.stream_type) fail('AI_CATEGORY_TYPE_MISMATCH');
      const existing=action.category_id?db.prepare('SELECT * FROM user_channels WHERE user_category_id=? AND provider_channel_id=?').get(cat.id,channel.provider_channel_id):null;
      if(existing && (existing.authorization_revoked || existing.is_hidden && !selected.has(existing.id))) fail('AI_PROTECTED_VALUE',409);
      if(existing && (pinned.has(existing.id)||existing.sort_order<keepFirst) && !selected.has(existing.id)) fail('AI_PROTECTED_VALUE',409);
      const max=action.category_id?db.prepare('SELECT COALESCE(MAX(sort_order),-1) AS n FROM user_channels WHERE user_category_id=?').get(cat.id).n:-1;
      const next=max+(sortCounts.get(cat.id)||0)+1; sortCounts.set(cat.id,(sortCounts.get(cat.id)||0)+1);
      action.user_channel_id=existing?.id??null;
      action.before=existing?pick(existing,assignmentFields):null;
      action.after={sort_order:next,is_hidden:0,assignment_origin:'manual',mapping_id:null,granted_by_admin:0,authorization_revoked:0};
      action.assignment_hash=existing?hash(existing):null;
    } else if(raw.type==='epg_mapping') {
      const channel=channelRecord(actor,userId,positiveId(raw.provider_channel_id));
      if(channel.manual_epg_id && !selected.has(channel.user_channel_id)) fail('AI_PROTECTED_VALUE',409);
      const epg=verifyEpg(actor,userId,{id:raw.epg_channel_id,source_type:raw.source_type,source_id:positiveId(raw.source_id)});
      action.provider_channel_id=channel.provider_channel_id;action.refs=[reference(channel)];action.epg=epg;action.epg_hash=hash(epg);
      action.before={epg_channel_id:channel.manual_epg_id||null};action.after={epg_channel_id:epg.id};
    } else {
      const id=positiveId(raw.user_channel_id),channel=assignment(actor,userId,id,selected.has(id));
      const explicit=selected.has(id);
      if((channel.is_hidden || pinned.has(id) || channel.sort_order<keepFirst) && !explicit) fail('AI_PROTECTED_VALUE',409);
      const field=FIELDS[raw.type];
      if(field==='custom_name' && channel.custom_name && !explicit) fail('AI_PROTECTED_VALUE',409);
      if(field==='is_hidden' && !explicit) {
        const peers=db.prepare(`SELECT pc.name,pc.epg_channel_id FROM authorized_user_channels uc
          JOIN user_categories cat ON cat.id=uc.user_category_id JOIN provider_channels pc ON pc.id=uc.provider_channel_id
          WHERE cat.user_id=? AND uc.id<>? AND pc.stream_type=?`).all(userId,id,channel.stream_type);
        if(!peers.some(peer=>normalName(peer.name)===normalName(channel.name) && peer.epg_channel_id===channel.epg_channel_id)) fail('AI_REGIONAL_VARIANT_PROTECTED',409);
      }
      let value=raw.value;
      if(field==='custom_name') {value=safeText(value,200).trim();if(!value) fail('AI_INVALID_ACTION');}
      if(field==='is_hidden') {if(value!==true && value!==1) fail('AI_INVALID_ACTION');value=1;}
      if(field==='sort_order' && (!Number.isSafeInteger(value)||value<0||value>1000000)) fail('AI_INVALID_ACTION');
      if(field==='sort_order') {
        const occupants=db.prepare('SELECT id,sort_order FROM user_channels WHERE user_category_id=? AND sort_order=? AND id<>?').all(channel.user_category_id,value,id);
        if(occupants.some(row=>(pinned.has(row.id)||row.sort_order<keepFirst)&&!selected.has(row.id))) fail('AI_PROTECTED_VALUE',409);
      }
      action.user_channel_id=id;action.provider_channel_id=channel.provider_channel_id;action.refs=[reference(channel,true,Boolean(channel.is_hidden))];
      action.before={[field]:channel[field]};action.after={[field]:value};
    }
    const target=action.user_channel_id?assignment(actor,userId,action.user_channel_id,true):action.provider_channel_id?channelRecord(actor,userId,action.provider_channel_id,{editing:true,allowHidden:true}):null;
    action.target_name=safeText(target?.custom_name||target?.name||action.before?.name||action.after?.name,200);
    const key=`${action.type}:${action.user_channel_id??action.provider_channel_id??action.category_id??action.id}:${action.category_id??action.category_action_id??''}`;
    if(seen.has(key)) fail('AI_DUPLICATE_ACTION');seen.add(key);
    if(!equal(action.before,action.after)) actions.push(action);
  }
  const id=randomUUID(),now=Date.now();
  const hiding=new Set(actions.filter(action=>action.type==='hide_channel').map(action=>action.user_channel_id));
  for(const action of actions.filter(action=>action.type==='hide_channel'&&!selected.has(action.user_channel_id))) {
    const original=assignment(actor,userId,action.user_channel_id);
    const peers=db.prepare(`SELECT uc.id,pc.id AS provider_channel_id,pc.name,pc.epg_channel_id FROM authorized_user_channels uc
      JOIN user_categories cat ON cat.id=uc.user_category_id JOIN provider_channels pc ON pc.id=uc.provider_channel_id
      WHERE cat.user_id=? AND pc.stream_type=? ORDER BY uc.id`).all(userId,original.stream_type);
    const survivor=peers.find(peer=>!hiding.has(peer.id)&&normalName(peer.name)===normalName(original.name)&&peer.epg_channel_id===original.epg_channel_id);
    if(!survivor) fail('AI_DUPLICATE_SURVIVOR_REQUIRED',409);
    action.refs.push(reference(channelRecord(actor,userId,survivor.provider_channel_id,{assignmentId:survivor.id})));
  }
  const data={feature:payload.feature,summary:safeText(summary,2000),actions,evidence,source_evidence:sourceEvidence};
  verifySourceEvidence(actor,userId,data);
  db.prepare('INSERT INTO ai_proposals(id,owner_key,user_id,data_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,ownerKey(actor),userId,JSON.stringify(data),'pending',now,now);
  return publicProposal({id,status:'pending',data});
}

function verifySourceEvidence(actor,userId,data) {
  if(data.feature!=='epg') return;
  const evidence=data.source_evidence;
  if(!evidence?.epg_catalog_hash || !evidence.epg_program_evidence) fail('AI_STALE_SOURCE',409);
  if(hash(allowedEpgChannels(actor,userId))!==evidence.epg_catalog_hash) fail('AI_STALE_SOURCE',409);
  verifyEpgProgramCatalog(actor,userId,evidence.epg_program_evidence);
}

function validateAction(actor,userId,action,version=true) {
  checkReferences(actor,userId,action.refs,{version});
  if(action.category_id) {
    const cat=category(userId,action.category_id);
    if(version && hash(cat)!==action.category_hash) fail('AI_STALE_PROPOSAL',409);
  }
  if(action.type==='create_category' && version && action.category_state!==hash(db.prepare('SELECT * FROM user_categories WHERE user_id=? ORDER BY id').all(userId))) fail('AI_STALE_PROPOSAL',409);
  if(action.type==='assign_channel') {
    permittedAdd(actor,userId,action.provider_channel_id);
    if(version && action.category_id) {
      const existing=db.prepare('SELECT * FROM user_channels WHERE user_category_id=? AND provider_channel_id=?').get(action.category_id,action.provider_channel_id);
      if((existing?hash(existing):null)!==action.assignment_hash) fail('AI_STALE_PROPOSAL',409);
    }
  }
  if(action.epg && hash(verifyEpg(actor,userId,action.epg))!==action.epg_hash) fail('AI_STALE_SOURCE',409);
}
export function getProposal(actor,id) {
  const row=record('ai_proposals',actor,id);
  checkReferences(actor,row.user_id,row.data.evidence);
  verifySourceEvidence(actor,row.user_id,row.data);
  if(row.status==='pending') {
    for(const action of row.data.actions) validateAction(actor,row.user_id,action);
  } else {
    for(const action of row.data.actions) validateAction(actor,row.user_id,{...action,refs:action.refs.map(ref=>({...ref,editing:true,allow_hidden:true}))},false);
  }
  return publicProposal(row);
}
function refreshChangedEvidence(actor,userId,refs,diffs) {
  return refs.map(ref=>{
    const categoryId=ref.assignment_id?db.prepare('SELECT user_category_id FROM user_channels WHERE id=?').get(ref.assignment_id)?.user_category_id:null;
    if(!diffs.some(diff=>diff.provider_channel_id===ref.channel_id || diff.table==='user_categories'&&diff.id===categoryId)) return ref;
    const row=channelRecord(actor,userId,ref.channel_id,{editing:ref.editing,assignmentId:ref.assignment_id,allowHidden:true});
    return reference(row,ref.editing||Boolean(row.is_hidden),Boolean(row.is_hidden));
  });
}
function updateFields(table,key,value,fields) {
  const allowed=table==='user_channels'?[...assignmentFields,'custom_name']:table==='user_categories'?['name','sort_order']:[];
  const names=Object.keys(fields);
  if(!names.length||names.some(name=>!allowed.includes(name))) fail('AI_INVALID_ACTION');
  db.prepare(`UPDATE ${table} SET ${names.map(name=>`${name}=?`).join(',')} WHERE ${key}=?`).run(...names.map(name=>fields[name]),value);
}
function validateChannelOrder(diffs,code) {
  const changed=new Set(diffs.filter(diff=>diff.table==='user_channels'&&diff.after.sort_order!==undefined).map(diff=>diff.id));
  const occupied=db.prepare(`SELECT 1 FROM user_channels edited JOIN user_channels sibling
    ON sibling.user_category_id=edited.user_category_id AND sibling.sort_order=edited.sort_order AND sibling.id<>edited.id
    WHERE edited.id=? LIMIT 1`);
  for(const id of changed) if(occupied.get(id)) fail(code,409);
}
export function applyProposal(actor,id,{action_ids,idempotency_key}={}) {
  if(!Array.isArray(action_ids)||!action_ids.length||action_ids.length>MAX_CANDIDATES||new Set(action_ids).size!==action_ids.length||typeof idempotency_key!=='string'||!idempotency_key||idempotency_key.length>200) fail('AI_INVALID_CONFIRMATION');
  const outcome=db.transaction(()=>{
    const row=record('ai_proposals',actor,id);
    validateFeatureActions(row.data.feature,row.data.actions);
    requireAiFeatureAccess(actor,row.data.feature);
    if(row.status==='applied') {
      const change=record('ai_changes',actor,row.change_id);
      if(change.data.idempotency_key!==idempotency_key || !equal(change.data.action_ids,[...action_ids].sort())) fail('AI_ALREADY_APPLIED',409);
      return {change_id:row.change_id,status:change.status};
    }
    if(row.status!=='pending') fail('AI_STALE_PROPOSAL',409);
    checkReferences(actor,row.user_id,row.data.evidence);
    verifySourceEvidence(actor,row.user_id,row.data);
    const selected=row.data.actions.filter(action=>action_ids.includes(action.id));
    if(selected.length!==action_ids.length) fail('AI_INVALID_CONFIRMATION');
    for(const action of selected) {
      if(action.dependencies.some(id=>!action_ids.includes(id))) fail('AI_MISSING_DEPENDENCY');
      validateAction(actor,row.user_id,action);
    }
    const created=new Map(),diffs=[];
    for(const action of selected) {
      if(action.type==='create_category') {
        const cat=createCategory(db,row.user_id,action.after);
        updateFields('user_categories','id',cat.id,{sort_order:action.after.sort_order});
        created.set(action.id,cat.id);
        diffs.push({table:'user_categories',id:cat.id,before:null,after:db.prepare('SELECT * FROM user_categories WHERE id=?').get(cat.id)});
      } else if(action.type==='assign_channel') {
        const catId=action.category_id??created.get(action.category_action_id);
        const current=db.prepare('SELECT * FROM user_channels WHERE user_category_id=? AND provider_channel_id=?').get(catId,action.provider_channel_id);
        const before=current?pick(current,assignmentFields):null;
        const {id:channelId}=addChannel(db,actor,catId,action.provider_channel_id,{sortOrder:action.after.sort_order});
        const after=before?action.after:db.prepare('SELECT * FROM user_channels WHERE id=?').get(channelId);
        diffs.push({table:'user_channels',id:channelId,provider_channel_id:action.provider_channel_id,before,after});
      } else if(action.type==='epg_mapping') {
        db.prepare(`INSERT INTO epg_channel_mappings(provider_channel_id,epg_channel_id) VALUES(?,?) ON CONFLICT(provider_channel_id) DO UPDATE SET epg_channel_id=excluded.epg_channel_id`).run(action.provider_channel_id,action.after.epg_channel_id);
        diffs.push({table:'epg_channel_mappings',id:action.provider_channel_id,provider_channel_id:action.provider_channel_id,before:action.before,after:action.after});
      } else {
        const table=action.type==='rename_category'?'user_categories':'user_channels',rowId=action.category_id??action.user_channel_id;
        const before=pick(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(rowId),Object.keys(action.after));
        updateFields(table,'id',rowId,action.after);
        diffs.push({table,id:rowId,provider_channel_id:action.provider_channel_id,before,after:action.after});
      }
    }
    // Check the final transaction state so confirmed swaps and cycles remain valid.
    validateChannelOrder(diffs,'AI_REORDER_CONFLICT');
    const changeId=randomUUID(),now=Date.now();
    const data={proposal_id:id,feature:row.data.feature,idempotency_key,action_ids:[...action_ids].sort(),diffs};
    db.prepare('INSERT INTO ai_changes(id,owner_key,user_id,data_json,status,created_at) VALUES(?,?,?,?,?,?)').run(changeId,ownerKey(actor),row.user_id,JSON.stringify(data),'applied',now);
    row.data.original_evidence=row.data.evidence;
    row.data.evidence=refreshChangedEvidence(actor,row.user_id,row.data.evidence,diffs);
    db.prepare("UPDATE ai_proposals SET status='applied',change_id=?,updated_at=?,data_json=? WHERE id=?").run(changeId,now,JSON.stringify(row.data),id);
    return {change_id:changeId,status:'applied',userId:row.user_id};
  })();
  if(outcome.userId) clearChannelsCache(outcome.userId);
  return {change_id:outcome.change_id,status:outcome.status};
}
function authorizeDiff(actor,userId,diff) {
  if(diff.provider_channel_id) {
    const row=channelRecord(actor,userId,diff.provider_channel_id,{editing:true,assignmentId:diff.table==='user_channels'?diff.id:null,allowHidden:true});
    if(diff.table==='user_channels' && row.user_channel_id!==diff.id) fail('AI_SOURCE_UNAVAILABLE',409);
  } else category(userId,diff.id);
}
export function listChanges(actor,userId) {
  const target=userId!=null||!actor.is_admin?targetUser(actor,userId):null;
  return db.prepare(`SELECT c.id,c.user_id,c.status,c.created_at,c.data_json FROM ai_changes c
    JOIN users u ON u.id=c.user_id WHERE c.owner_key=? AND c.created_at>=?
    AND (? IS NULL OR c.user_id=?) AND u.is_active=1 AND (u.expiry_date IS NULL OR u.expiry_date=0 OR u.expiry_date>=?)
    ORDER BY c.created_at DESC,c.id DESC LIMIT 50`).all(ownerKey(actor),Date.now()-RETENTION_MS,target,target,Date.now()/1000)
    .map(row=>{
      const data=JSON.parse(row.data_json);
      return {id:row.id,user_id:row.user_id,feature:data.feature,status:row.status,created_at:row.created_at,...(data.rule_id?{rule_id:data.rule_id}:{})};
    });
}
export function getChange(actor,id) {
  const row=record('ai_changes',actor,id);
  for(const diff of row.data.diffs) {
    if(row.status!=='undone') authorizeDiff(actor,row.user_id,diff);
    else if(diff.provider_channel_id) channelRecord(actor,row.user_id,diff.provider_channel_id,{editing:true,allowHidden:true});
    else if(diff.before!==null) category(row.user_id,diff.id);
  }
  return {id,status:row.status,feature:row.data.feature,proposal_id:row.data.proposal_id,action_ids:row.data.action_ids||[],diffs:row.data.diffs.map(diff=>({...diff,before:displayValues(diff.before),after:displayValues(diff.after)}))};
}
export function undoChange(actor,id) {
  const userId=db.transaction(()=>{
    const row=record('ai_changes',actor,id);
    if(row.status==='undone') return row.user_id;
    for(const diff of [...row.data.diffs].reverse()) {
      authorizeDiff(actor,row.user_id,diff);
      const key=diff.table==='epg_channel_mappings'?'provider_channel_id':'id';
      const current=db.prepare(`SELECT * FROM ${diff.table} WHERE ${key}=?`).get(diff.id);
      if(!current||!equal(pick(current,Object.keys(diff.after)),diff.after)) fail('AI_UNDO_CONFLICT',409);
      if(diff.before===null) {
        if(diff.table==='user_categories' && (db.prepare('SELECT 1 FROM user_channels WHERE user_category_id=? LIMIT 1').get(diff.id)||db.prepare('SELECT 1 FROM category_mappings WHERE user_category_id=? LIMIT 1').get(diff.id))) fail('AI_UNDO_CONFLICT',409);
        db.prepare(`DELETE FROM ${diff.table} WHERE ${key}=?`).run(diff.id);
      } else if(diff.table==='epg_channel_mappings') {
        if(diff.before.epg_channel_id===null) db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id=?').run(diff.id);
        else db.prepare('UPDATE epg_channel_mappings SET epg_channel_id=? WHERE provider_channel_id=?').run(diff.before.epg_channel_id,diff.id);
      } else {
        // Revocation and grant fields are never restored by undo.
        const fields=Object.fromEntries(Object.entries(diff.before).filter(([key])=>!['authorization_revoked','granted_by_admin'].includes(key)));
        updateFields(diff.table,'id',diff.id,fields);
      }
    }
    validateChannelOrder(row.data.diffs,'AI_UNDO_CONFLICT');
    db.prepare("UPDATE ai_changes SET status='undone' WHERE id=?").run(id);
    if(row.data.proposal_id) {
      const proposal=record('ai_proposals',actor,row.data.proposal_id);
      proposal.data.evidence=refreshChangedEvidence(actor,row.user_id,proposal.data.original_evidence||proposal.data.evidence,row.data.diffs);
      db.prepare("UPDATE ai_proposals SET status='undone',updated_at=?,data_json=? WHERE id=?").run(Date.now(),JSON.stringify(proposal.data),row.data.proposal_id);
    }
    return row.user_id;
  })();
  clearChannelsCache(userId);
  return {change_id:id,status:'undone'};
}
