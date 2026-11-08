import { expiryEpoch } from '../../utils/stalker.js';
import { createHash } from 'node:crypto';
import db from '../../database/db.js';
import epgDb from '../../database/epgDb.js';

export const RETENTION_MS = 30 * 86400000;
export const MAX_CANDIDATES = 2000;
export const MAX_PROPOSAL_ACTIONS = MAX_CANDIDATES * 2;
db.function('ai_lower',{deterministic:true},value=>String(value??'').toLowerCase());
function movieYear(releaseDate,name) {
  const date=String(releaseDate??'').trim();
  if(/^(?:18|19|20)\d{2}$|^2100$/.test(date)) return {year:Number(date),source:'provider'};
  if(/^(?:18|19|20)\d{2}-\d{2}-\d{2}$|^2100-\d{2}-\d{2}$/.test(date)) {
    const time=Date.parse(date+'T00:00:00Z');
    if(Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===date) return {year:Number(date.slice(0,4)),source:'provider'};
  }
  const years=[...new Set(Array.from(String(name??'').matchAll(/(?<![\p{L}\p{N}])((?:18|19|20)\d{2}|2100)(?![\p{L}\p{N}])/gu),match=>Number(match[1])))];
  return years.length===1?{year:years[0],source:'title'}:{year:null,source:null};
}
db.function('ai_movie_year',{deterministic:true},(date,name)=>movieYear(date,name).year);
function languageClues(terms) {
  const german=/^(?:(?:german|germany|deutsch|deutschland|de)(?:\s*[-|:]|\s*)|\[de\]|\(de\))$/i;
  if(!terms.some(term=>german.test(term))) return terms;
  return [...new Set([...terms.filter(term=>!german.test(term)),'German','Germany','Deutsch','DE -','DE-','DE |','DE|','DE:','DE :','[DE]','(DE)'])];
}
function movieMetadata(row,name) {
  const {year,source}=movieYear(row.releaseDate,name);
  const rating=String(row.rating??'').trim();
  const numeric=/^\d+(?:\.\d+)?$/.test(rating)?Number(rating):NaN;
  const valid=Number.isFinite(numeric)&&numeric>=0&&numeric<=10;
  return {release_year:year,year_source:source,provider_rating:valid?numeric:null,rating_source:valid?'provider':null};
}
export const ownerKey = actor => `${actor.is_admin ? 'admin' : 'user'}:${actor.id}`;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  throw error;
}
export function positiveId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail('AI_INVALID_ID');
  return number;
}
export function ids(value = [], max = MAX_CANDIDATES) {
  if (!Array.isArray(value) || value.length > max) fail('AI_INVALID_IDS');
  return [...new Set(value.map(positiveId))];
}
export function safeText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value.slice(0, max * 3)
    .replace(/(?:https?|rtsp|rtmp|file):\/\/[^\s<>"']+/gi, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/\b(?:password|passwd|api[_ -]?key|token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted]')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max);
}
export function targetUser(actor, userId) {
  const id = positiveId(userId ?? (actor.is_admin ? null : actor.id));
  if (!actor.is_admin && id !== Number(actor.id)) fail('AI_FORBIDDEN', 403);
  const user = db.prepare('SELECT id,is_active,expiry_date FROM users WHERE id=?').get(id);
  const expires = expiryEpoch(user?.expiry_date);
  if (!user || !user.is_active || expires && expires <= Date.now()/1000) fail('AI_FORBIDDEN', 403);
  return id;
}

// Correlating the category check avoids catalog-by-category probes when counting rows.
const channelSelect = `SELECT pc.id AS provider_channel_id, pc.provider_id, pc.name, pc.stream_type,
  pc.epg_channel_id, pc.plot, pc.genre, pc.episode_run_time, pc.original_category_id,
  uc.id AS user_channel_id, uc.user_category_id, uc.custom_name, uc.sort_order,
  uc.is_hidden, uc.assignment_origin, uc.mapping_id, uc.granted_by_admin, uc.authorization_revoked,
  cat.name AS category_name, cat.is_adult, map.epg_channel_id AS manual_epg_id
  FROM provider_channels pc JOIN providers p ON p.id=pc.provider_id
  LEFT JOIN user_channels uc ON uc.provider_channel_id=pc.id
    AND EXISTS (SELECT 1 FROM user_categories owner_cat WHERE owner_cat.id=uc.user_category_id AND owner_cat.user_id=@userId)
  LEFT JOIN user_categories cat ON cat.id=uc.user_category_id
  LEFT JOIN epg_channel_mappings map ON map.provider_channel_id=pc.id`;

export function channelRecord(actor, userId, channelId, { editing = false, assignmentId = null, allowHidden = false } = {}) {
  targetUser(actor, userId);
  const condition = editing
    ? '(p.user_id=@userId OR uc.granted_by_admin=1)'
    : 'uc.id IN (SELECT id FROM authorized_user_channels) AND uc.is_hidden=0';
  const rows = db.prepare(`${channelSelect} WHERE pc.id=@channelId AND ${condition}
    AND (@assignmentId IS NULL OR uc.id=@assignmentId)
    ORDER BY uc.id`).all({ userId, channelId: positiveId(channelId), admin: actor.is_admin ? 1 : 0, assignmentId });
  const row = rows.find(row => !row.authorization_revoked && (allowHidden || !row.is_hidden));
  if (!row) fail('AI_SOURCE_UNAVAILABLE', 409);
  return row;
}

export function publicChannel(row) {
  return {
    provider_channel_id: row.provider_channel_id, user_channel_id: row.user_channel_id,
    category_id: row.user_category_id, provider_id: row.provider_id,
    name: safeText(row.custom_name || row.name, 200), original_name: safeText(row.name, 200),
    category: safeText(row.category_name, 160), type: row.stream_type,
    genre: safeText(row.genre, 120) || null, description: safeText(row.plot, 1000) || null,
    duration: /^\d+(?:\.\d+)?$/.test(row.episode_run_time || '') ? Number(row.episode_run_time) : null,
    language: null, region: null, quality: null,
    epg_channel_id: safeText(row.manual_epg_id || row.epg_channel_id, 200),
    manual_name: Boolean(row.custom_name), manual_epg: Boolean(row.manual_epg_id),
    sort_order: row.sort_order, hidden: Boolean(row.is_hidden), is_adult: Boolean(row.is_adult)
  };
}

export function reference(row, editing = false, allowHidden = false) {
  return { channel_id: row.provider_channel_id, assignment_id: row.user_channel_id, editing, allow_hidden: allowHidden, hash: hash(row) };
}
export function checkReferences(actor, userId, refs, { version = true } = {}) {
  targetUser(actor, userId);
  if (!Array.isArray(refs) || refs.length > MAX_CANDIDATES * 3) fail('AI_INVALID_RESULT');
  for (const ref of refs) {
    const row = channelRecord(actor, userId, ref.channel_id, {editing:ref.editing,assignmentId:ref.assignment_id,allowHidden:ref.allow_hidden});
    if (version && ref.hash !== hash(row)) fail('AI_STALE_SOURCE', 409);
  }
  if(version) checkMetadataReferences(refs);
}
// Call only after authenticating the source IDs, including compact result references.
export function checkMetadataReferences(refs) {
  if(!Array.isArray(refs) || refs.length>MAX_CANDIDATES*3) fail('AI_INVALID_RESULT');
  const lookup=db.prepare('SELECT rating,releaseDate FROM provider_channels WHERE id=?');
  for(const ref of refs) if(ref.metadata_hash!==undefined) {
    const metadata=lookup.get(positiveId(ref.channel_id));
    if(!metadata) fail('AI_SOURCE_UNAVAILABLE',409);
    if(ref.metadata_hash!==hash(metadata)) fail('AI_STALE_SOURCE',409);
  }
}

export function buildContext(actor, payload, selection = null, candidateLimit = Infinity) {
  const userId = targetUser(actor, payload.user_id);
  const selectedIds = ids(payload.selected_ids);
  const channelIds = ids(payload.channel_ids ?? (payload.provider_channel_id ? [payload.provider_channel_id] : []));
  const selectedDiagnosis = payload.feature === 'diagnose' && (selectedIds.length > 0 || channelIds.length > 0);
  const editing = ['list','cleanup','duplicates'].includes(payload.feature) || selectedDiagnosis;
  const requestedOffset = Number(payload.offset || 0);
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 1000000) fail('AI_INVALID_OFFSET');
  const offset=selection?0:requestedOffset;
  const params = {userId};
  const clauses = [editing
    ? `(uc.id IN (SELECT id FROM authorized_user_channels) OR (p.user_id=@userId AND uc.id IS NULL))`
    : 'uc.id IN (SELECT id FROM authorized_user_channels)'];
  if (selectedDiagnosis) {
    clauses[0] = '(p.user_id=@userId OR uc.granted_by_admin=1) AND COALESCE(uc.authorization_revoked,0)=0';
    if(selectedIds.length) clauses.push(`uc.id IN (${selectedIds.map((id,i)=>{params['selected'+i]=id;return '@selected'+i;}).join(',')})`);
  } else if (selectedIds.length && editing) {
    clauses[0] = `(${clauses[0]} OR (uc.id IN (${selectedIds.map((id,i)=> {params['selected'+i]=id;return '@selected'+i;}).join(',')}) AND uc.authorization_revoked=0 AND (p.user_id=@userId OR uc.granted_by_admin=1)))`;
  }
  if (channelIds.length) clauses.push(`pc.id IN (${channelIds.map((id,i)=>{params['id'+i]=id;return '@id'+i;}).join(',')})`);
  if (payload.category_id) { params.categoryId=positiveId(payload.category_id); clauses.push('uc.user_category_id=@categoryId'); }
  if(selection) {
    if(channelIds.length) {
      const scoped=db.prepare(`${channelSelect} WHERE ${clauses.join(' AND ')}`).all(params);
      if(channelIds.some(id=>!scoped.some(row=>row.provider_channel_id===id))) fail('AI_SOURCE_UNAVAILABLE',409);
    }
    if(selection.type) {params.selectionType=selection.type;clauses.push('pc.stream_type=@selectionType');}
    for(const key of ['terms','language_terms']) if(selection[key].length) {
      const terms=key==='language_terms'?languageClues(selection[key]):selection[key];
      const fields=['pc.name','uc.custom_name','cat.name','pc.genre'];
      clauses.push(`(${terms.map((term,i)=>{
        const param=`${key}${i}`;params[param]=term.toLowerCase();
        const lower=Buffer.byteLength(term)===term.length?'lower':'ai_lower';
        return fields.map(field=>`instr(${lower}(COALESCE(${field},'')),@${param})>0`).join(' OR ');
      }).join(' OR ')})`);
    }
    if(selection.year_from!=null) {
      params.yearFrom=selection.year_from;params.yearTo=selection.year_to;
      clauses.push("pc.stream_type='movie' AND ai_movie_year(pc.releaseDate,pc.name) BETWEEN @yearFrom AND @yearTo");
    }
  }
  const sql = `${channelSelect} WHERE ${clauses.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS total FROM (${sql})`).get(params).total;
  const reviewLimit=payload.full_list===true?MAX_CANDIDATES:240;
  const expandedCandidateLimit=Math.min(MAX_CANDIDATES,candidateLimit);
  const limit=Math.min(reviewLimit,selection?expandedCandidateLimit:MAX_CANDIDATES);
  const requiresNarrowing=Boolean(selection && total>limit);
  const rows = requiresNarrowing?[]:db.prepare(`${sql} ORDER BY pc.id,uc.id LIMIT @limit OFFSET @offset`).all({...params,limit,offset});
  if (!selection && channelIds.some(id => !rows.some(row => row.provider_channel_id === id))) fail('AI_SOURCE_UNAVAILABLE',409);
  if (selectedDiagnosis && selectedIds.some(id => !rows.some(row => row.user_channel_id === id))) fail('AI_SOURCE_UNAVAILABLE',409);
  const categories = db.prepare('SELECT id,name,type,sort_order,is_adult FROM user_categories WHERE user_id=? ORDER BY sort_order,id LIMIT 500').all(userId)
    .map(row=>({...row,name:safeText(row.name,160)}));
  const movieIds=[...new Set(rows.filter(row=>payload.feature==='list' && row.stream_type==='movie').map(row=>row.provider_channel_id))];
  const metadata=new Map(movieIds.length?db.prepare(`SELECT id,rating,releaseDate FROM provider_channels WHERE id IN (${movieIds.map(()=>'?').join(',')})`).all(...movieIds).map(({id,...value})=>[id,value]):[]);
  const refs = rows.map(row=>({...reference(row,editing,Boolean(row.is_hidden)),...(metadata.has(row.provider_channel_id)?{metadata_hash:hash(metadata.get(row.provider_channel_id))}:{})}));
  return { userId,rows,refs,categories,items:rows.map(row=>({...publicChannel(row),...(metadata.has(row.provider_channel_id)?movieMetadata(metadata.get(row.provider_channel_id),row.name):{})})),
    coverage:{processed:rows.length,total,offset,partial:offset>0||offset+rows.length<total,next_offset:!selection&&offset+rows.length<total?offset+rows.length:null,
      ...(selection?{requires_narrowing:requiresNarrowing,candidate_limit:limit,review_limit:reviewLimit,
        expanded_candidate_limit:expandedCandidateLimit,budget_limited:total>candidateLimit}:{})} };
}

// Walk the authorized catalog locally so a page boundary cannot conceal a duplicate.
// Only relevant group representatives leave this iterator, never the global catalog.
export function iterateEditableChannels(actor,userId) {
  targetUser(actor,userId);
  return db.prepare(`${channelSelect} WHERE uc.id IN (SELECT id FROM authorized_user_channels)
    OR (p.user_id=@userId AND uc.id IS NULL) ORDER BY pc.id,uc.id`).iterate({userId});
}

export function epgSources(actor, userId) {
  targetUser(actor,userId);
  const providers = db.prepare(`SELECT id FROM providers WHERE user_id=? OR id IN (
    SELECT pc.provider_id FROM authorized_user_channels uc JOIN user_categories cat ON cat.id=uc.user_category_id
    JOIN provider_channels pc ON pc.id=uc.provider_channel_id WHERE cat.user_id=?)`).all(userId,userId).map(row=>row.id);
  const custom = db.prepare('SELECT id FROM epg_sources WHERE enabled=1').all().map(row=>row.id);
  return {providers,custom};
}
export function allowedEpgChannels(actor,userId) {
  const {providers,custom}=epgSources(actor,userId);
  // EPG ids are evidence, never model-created identities; source owner is checked separately.
  const rows=[];
  for(const [type,sourceIds] of [['provider',providers],['custom',custom]]) {
    for(const id of sourceIds) {
      rows.push(...epgDb.prepare('SELECT id,name,source_type,source_id,updated_at FROM epg_channels WHERE source_type=? AND source_id=? ORDER BY id LIMIT ?').all(type,id,Math.max(0,5000-rows.length)));
      if(rows.length>=5000) break;
    }
  }
  return rows;
}
export function verifyEpg(actor,userId,candidate) {
  const sources=epgSources(actor,userId);
  const sourceIds=candidate.source_type==='provider'?sources.providers:candidate.source_type==='custom'?sources.custom:[];
  if(!sourceIds.includes(Number(candidate.source_id))) fail('AI_SOURCE_UNAVAILABLE',409);
  const row=epgDb.prepare('SELECT id,name,source_type,source_id,updated_at FROM epg_channels WHERE id=? AND source_type=? AND source_id=?')
    .get(candidate.id,candidate.source_type,candidate.source_id);
  if(!row) fail('AI_SOURCE_UNAVAILABLE',409);
  return row;
}
export function sourceDescription(actor,userId,channelId,program) {
  const row=channelRecord(actor,userId,channelId);
  if(!program) return {text:safeText(row.plot,6000),source_hash:hash(row.plot),reference:reference(row)};
  if(program.channel_id!==(row.manual_epg_id||row.epg_channel_id)) fail('AI_SOURCE_UNAVAILABLE',409);
  verifyEpg(actor,userId,{...program,id:program.channel_id});
  const value=epgDb.prepare('SELECT desc,stop FROM epg_programs WHERE channel_id=? AND source_type=? AND source_id=? AND start=?')
    .get(program.channel_id,program.source_type,program.source_id,program.start);
  if(!value || value.stop<Date.now()/1000) fail('AI_SOURCE_UNAVAILABLE',409);
  return {text:safeText(value.desc,6000),source_hash:hash(value.desc),reference:reference(row)};
}

export function prunePrivateRecords() {
  const cutoff=Date.now()-RETENTION_MS;
  for(const [table,time] of [['ai_proposals','updated_at'],['ai_changes','created_at'],['ai_conversations','updated_at'],['ai_enrichments','created_at']]) {
    db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${time}<? OR (owner_key LIKE 'user:%' AND NOT EXISTS(SELECT 1 FROM users WHERE owner_key='user:'||users.id)) OR (owner_key LIKE 'admin:%' AND NOT EXISTS(SELECT 1 FROM admin_users WHERE owner_key='admin:'||admin_users.id)) LIMIT 100)`).run(cutoff);
  }
}
