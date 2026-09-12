import { randomUUID } from 'node:crypto';
import db from '../../database/db.js';
import { encrypt } from '../../utils/crypto.js';
import { aiError, normalizeBaseUrl, validateJson, AI_TIMEOUT_MS } from './transport.js';
import { adapterFor, providerOf, normalizeProvider, providerTimeout, DEFAULT_PROVIDER, MODEL_ID } from './providers/index.js';
import { readCredentialRecord } from './codex/credentials.js';
import { codexReadinessSnapshot } from './codex/readiness.js';

const FEATURES = ['list','cleanup','duplicates','epg','sync','search','diagnose','text'];
const DEFAULT_SETTINGS = { enabled: false, allow_own_connections: false, allowed_user_ids: [], functions: FEATURES, internal_targets: [] };
const DEFAULT_PREFERENCES = { enabled: false, connection_id: null, model_id: null, language: 'en', timezone: 'UTC', auto_sync_summary: false };
const TEST_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const MAX_MODEL_PROFILES = 100;
const ownerKey = actor => `${actor.is_admin ? 'admin' : 'user'}:${actor.id}`;

function freshActor(actor) {
    if (!actor || !Number.isSafeInteger(actor.id) || actor.id < 1 || typeof actor.is_admin !== 'boolean') throw aiError('AI_FORBIDDEN',403);
    const row = db.prepare(`SELECT * FROM ${actor.is_admin ? 'admin_users' : 'users'} WHERE id=?`).get(actor.id);
    if (!row?.is_active || (!actor.is_admin && (row.webui_access === 0 || (row.expiry_date && row.expiry_date < Date.now()/1000)))) throw aiError('AI_FORBIDDEN',403);
    return actor;
}
function settings() {
    const row = db.prepare("SELECT value FROM settings WHERE key='ai_policy'").get();
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}
export function isAiEnabled() {
    try { return settings().enabled === true; } catch { return false; }
}
function preferences(actor) {
    const row = db.prepare('SELECT data_json FROM ai_preferences WHERE owner_key=?').get(ownerKey(actor));
    return { ...DEFAULT_PREFERENCES, ...(row ? JSON.parse(row.data_json) : {}) };
}
function eligible(actor, policy) {
    freshActor(actor);
    if (!actor.is_admin && !policy.allowed_user_ids.includes(actor.id)) throw aiError('AI_FORBIDDEN',403);
}
function inputObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 32000) throw aiError('AI_INVALID_INPUT');
}
function bool(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw aiError('AI_INVALID_INPUT');
    return value;
}
function ids(value, fallback) {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.length > 1000 || value.some(id => !Number.isSafeInteger(id) || id < 1)) throw aiError('AI_INVALID_INPUT');
    return [...new Set(value)];
}
function functions(value, fallback) {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some(feature => !FEATURES.includes(feature))) throw aiError('AI_INVALID_INPUT');
    return [...new Set(value)];
}
function retainedProfiles(connection,limit=MAX_MODEL_PROFILES) {
    const entries=Object.entries(connection.capabilities);
    if(entries.length<=limit) return connection.capabilities;
    const personal=db.prepare("SELECT json_extract(data_json,'$.model_id') AS model FROM ai_preferences WHERE owner_key=? AND json_extract(data_json,'$.connection_id')=?").get(connection.owner_key,connection.id)?.model;
    const selected=new Set([connection.model_id,personal]);
    return Object.fromEntries(entries.sort(([a,av],[b,bv])=>Number(selected.has(b))-Number(selected.has(a))
        || (bv.tested_at||0)-(av.tested_at||0) || a.localeCompare(b)).slice(0,limit));
}
function rowConnection(row) {
    if(!row) return null;
    const connection={...JSON.parse(row.data_json),id:row.id,owner_key:row.owner_key,version:row.version};
    // Connections stored before the personal ChatGPT adapter carry no marker and
    // stay on the existing API transport.
    connection.provider=providerOf(connection);
    // Bound legacy responses without making reads write to the database.
    connection.capabilities=retainedProfiles(connection);
    return connection;
}
function loadConnection(id) {
    if (typeof id !== 'string' || id.length > 100) throw aiError('AI_NOT_FOUND',404);
    return rowConnection(db.prepare('SELECT * FROM ai_connections WHERE id=?').get(id));
}
function canUse(actor, connection, policy) {
    if (!connection) return false;
    if (connection.owner_key === ownerKey(actor)) return actor.is_admin || policy.allow_own_connections;
    // A personal ChatGPT sign-in is private by construction. Even a stored or
    // manipulated `shared` flag cannot turn it into a service for other accounts.
    if (!adapterFor(connection).shareable) return false;
    return connection.owner_key.startsWith('admin:') && connection.shared && !actor.is_admin && connection.allowed_user_ids.includes(actor.id)
        && !!db.prepare('SELECT is_active FROM admin_users WHERE id=?').get(Number(connection.owner_key.slice(6)))?.is_active;
}
function owned(actor,id) {
    freshActor(actor); const connection=loadConnection(id);
    if (!connection || connection.owner_key !== ownerKey(actor)) throw aiError('AI_FORBIDDEN',403);
    return connection;
}
function publicConnection(connection,actor) {
    const result=Object.fromEntries(['id','name','provider','base_url','shared','allowed_user_ids','functions','enabled','model_id','models','capabilities','version','token_parameter'].map(key => [key, connection[key]]).concat([['has_key',!!connection.encrypted_key],['editable',connection.owner_key===ownerKey(actor)]]));
    if (!result.editable) result.allowed_user_ids=[];
    if (providerOf(connection)!==DEFAULT_PROVIDER) {
        // Never expose a token, only whether this owner's account is linked and
        // the masked label the owner already knows.
        const record=result.editable ? readCredentialRecord(connection.owner_key,connection.id) : null;
        result.account={linked:Boolean(record),label:record?.account_label ?? null,plan_type:record?.plan_type ?? null,auth_method:record?.auth_method ?? null};
        result.has_key=false;
    }
    return result;
}
function persist(connection, expectedVersion = null) {
    connection.version=(expectedVersion ?? 0)+1;
    connection.capabilities=retainedProfiles(connection);
    const { id,owner_key,version,...data }=connection;
    if (expectedVersion !== null) {
        const updated=db.prepare('UPDATE ai_connections SET data_json=?,version=?,updated_at=? WHERE id=? AND version=?').run(JSON.stringify(data),version,Date.now(),id,expectedVersion);
        if (!updated.changes) throw aiError('AI_CONNECTION_CHANGED',409);
    } else {
        db.prepare('INSERT INTO ai_connections(id,owner_key,data_json,version,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,version=excluded.version,updated_at=excluded.updated_at').run(id,owner_key,JSON.stringify(data),version,Date.now(),Date.now());
    }
}
function clearModelSelection(connectionId,model=null) {
    db.prepare("UPDATE ai_preferences SET data_json=json_set(data_json,'$.model_id',NULL) WHERE json_extract(data_json,'$.connection_id')=? AND (? IS NULL OR json_extract(data_json,'$.model_id')=?)").run(connectionId,model,model);
}
function testedProfile(connection,model) {
    const profile=connection.capabilities[model];
    if (!profile?.chat) return false;
    // Providers without a token-limit parameter cannot invalidate a profile through it.
    return adapterFor(connection).usesTokenParameter ? profile.token_parameter===connection.token_parameter : true;
}

export function getAiSettings(actor) {
    freshActor(actor); const policy=settings();
    return actor.is_admin ? policy : { enabled:policy.enabled, allow_own_connections:policy.allow_own_connections, allowed:policy.allowed_user_ids.includes(actor.id), functions:policy.functions };
}
export function updateAiSettings(actor,input) {
    freshActor(actor); if (!actor.is_admin) throw aiError('AI_FORBIDDEN',403); inputObject(input);
    const old=settings();
    const policy={ enabled:bool(input.enabled,old.enabled), allow_own_connections:bool(input.allow_own_connections,old.allow_own_connections), allowed_user_ids:ids(input.allowed_user_ids,old.allowed_user_ids), functions:functions(input.functions,old.functions), internal_targets:old.internal_targets };
    if (input.internal_targets !== undefined) {
        if (!Array.isArray(input.internal_targets) || input.internal_targets.length>20) throw aiError('AI_INVALID_INPUT');
        policy.internal_targets=[...new Set(input.internal_targets.map(normalizeBaseUrl))];
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('ai_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
    return policy;
}
export function getPreferences(actor) { freshActor(actor); return preferences(actor); }
export function savePreferences(actor,input) {
    freshActor(actor); inputObject(input); const old=preferences(actor), policy=settings();
    const next={...old, enabled:bool(input.enabled,old.enabled),auto_sync_summary:bool(input.auto_sync_summary,old.auto_sync_summary)};
    if (input.connection_id !== undefined) {
        if (input.connection_id !== null && !canUse(actor,loadConnection(input.connection_id),policy)) throw aiError('AI_FORBIDDEN',403);
        next.connection_id=input.connection_id; if (next.connection_id !== old.connection_id) next.model_id=null;
    }
    if (input.model_id !== undefined) {
        if (input.model_id !== null) {
            const c=next.connection_id && loadConnection(next.connection_id);
            if (!canUse(actor,c,policy) || !MODEL_ID.test(input.model_id) || !testedProfile(c,input.model_id) || (c.owner_key !== ownerKey(actor) && input.model_id !== c.model_id)) throw aiError('AI_MODEL_REQUIRED');
        }
        next.model_id=input.model_id;
    }
    if (input.language !== undefined) { if (!['de','en','fr','el'].includes(input.language)) throw aiError('AI_INVALID_INPUT'); next.language=input.language; }
    if (input.timezone !== undefined) {
        try { if (typeof input.timezone !== 'string' || input.timezone.length>100) throw new Error(); new Intl.DateTimeFormat('en',{timeZone:input.timezone}); } catch { throw aiError('AI_INVALID_INPUT'); }
        next.timezone=input.timezone;
    }
    db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES(?,?) ON CONFLICT(owner_key) DO UPDATE SET data_json=excluded.data_json').run(ownerKey(actor),JSON.stringify(next));
    return next;
}
export function listConnections(actor) {
    freshActor(actor); const policy=settings();
    if (!actor.is_admin && !policy.allowed_user_ids.includes(actor.id)) return [];
    return db.prepare("SELECT * FROM ai_connections WHERE owner_key=? OR owner_key LIKE 'admin:%' ORDER BY created_at").all(ownerKey(actor)).map(rowConnection).filter(c=>canUse(actor,c,policy)).map(c=>publicConnection(c,actor));
}
export function saveConnection(actor,input,id=null) {
    freshActor(actor); inputObject(input); const policy=settings(); eligible(actor,policy);
    if (!actor.is_admin && !policy.allow_own_connections) throw aiError('AI_FORBIDDEN',403);
    const old=id ? owned(actor,id) : {id:randomUUID(),owner_key:ownerKey(actor),version:0,name:'AI',provider:normalizeProvider(input.provider),base_url:null,encrypted_key:null,shared:false,allowed_user_ids:[],functions:FEATURES,enabled:true,model_id:null,models:[],capabilities:{},token_parameter:'max_tokens'};
    if (!id && db.prepare('SELECT count(*) AS n FROM ai_connections WHERE owner_key=?').get(ownerKey(actor)).n>=10) throw aiError('AI_RATE_LIMIT',429);
    // The provider decides the credential and transport identity of a connection
    // and can never be switched underneath stored credentials or tested models.
    if (id && input.provider !== undefined && normalizeProvider(input.provider) !== providerOf(old)) throw aiError('AI_INVALID_INPUT');
    const adapter=adapterFor(old);
    // Only creating a connection requires the runtime to be offered. Renaming,
    // disabling or deleting an existing one must stay possible after the host
    // loses its sandbox.
    if (!id && adapter.supportsAccountLink) {
        const readiness=codexReadinessSnapshot();
        if (!readiness.available) throw aiError(readiness.reason,503);
    }
    const next={...old,provider:providerOf(old),enabled:bool(input.enabled,old.enabled),functions:functions(input.functions,old.functions)};
    if (input.name !== undefined) { if (typeof input.name !== 'string' || !input.name.trim() || input.name.length>100) throw aiError('AI_INVALID_INPUT'); next.name=input.name.trim(); }
    if (adapter.requiresBaseUrl) {
        if (input.base_url !== undefined) next.base_url=normalizeBaseUrl(input.base_url);
        if (!next.base_url) throw aiError('AI_INVALID_INPUT');
        if (input.api_key !== undefined) {
            if (typeof input.api_key !== 'string' || input.api_key.length>4096 || /[\r\n]/.test(input.api_key)) throw aiError('AI_INVALID_INPUT');
            next.encrypted_key=input.api_key ? encrypt(input.api_key) : null;
        }
        if (!next.encrypted_key && !policy.internal_targets.includes(next.base_url)) throw aiError('AI_INVALID_INPUT');
    } else {
        // A managed ChatGPT sign-in has no user-supplied address or key. Sending
        // one is a rejected request, not a silently ignored field.
        if (input.base_url !== undefined || input.api_key !== undefined) throw aiError('AI_INVALID_INPUT');
        next.base_url=null; next.encrypted_key=null;
    }
    if (input.shared !== undefined || input.allowed_user_ids !== undefined) {
        if (!actor.is_admin) throw aiError('AI_FORBIDDEN',403);
        if (!adapter.shareable && (bool(input.shared,false) || ids(input.allowed_user_ids,[]).length)) throw aiError('AI_FORBIDDEN',403);
        next.shared=adapter.shareable ? bool(input.shared,old.shared) : false;
        next.allowed_user_ids=adapter.shareable ? ids(input.allowed_user_ids,old.allowed_user_ids) : [];
    }
    // Enforced on every write, so a legacy or manipulated record cannot keep a
    // private connection marked as shared.
    if (!adapter.shareable) { next.shared=false; next.allowed_user_ids=[]; }
    if (input.token_parameter !== undefined) {
        if (!adapter.usesTokenParameter) throw aiError('AI_INVALID_INPUT');
        if (!['max_tokens','max_completion_tokens'].includes(input.token_parameter)) throw aiError('AI_INVALID_INPUT');
        next.token_parameter=input.token_parameter;
    }
    const identityChanged=adapter.requiresBaseUrl && (next.base_url !== old.base_url || input.api_key !== undefined);
    const profileChanged=next.token_parameter !== old.token_parameter;
    // A tested alternate profile is adopted only with an explicit model selection.
    const invalidated=identityChanged || (profileChanged && !(input.model_id && testedProfile(next,input.model_id)));
    if (invalidated) { next.models=[]; next.capabilities={}; next.model_id=null; }
    if (input.model_id !== undefined && !invalidated) {
        if (input.model_id !== null && (typeof input.model_id !== 'string' || !MODEL_ID.test(input.model_id) || !testedProfile(next,input.model_id))) throw aiError('AI_MODEL_REQUIRED');
        next.model_id=input.model_id;
    }
    db.transaction(()=>{ persist(next,id ? old.version : null); if(invalidated || profileChanged) clearModelSelection(next.id); })();
    return publicConnection(next,actor);
}
// Raw removal. It performs no runtime teardown; use `removeConnection` for
// anything reachable from a request.
export function deleteConnection(actor,id) { owned(actor,id); db.prepare('DELETE FROM ai_connections WHERE id=? AND owner_key=?').run(id,ownerKey(actor)); return {deleted:true}; }
// Endpoint-level removal. An account-linked connection stops its runtime, waits
// for the owning worker to acknowledge and signs out before the row disappears;
// otherwise the deletion trigger drops the lease while a runtime is still using
// the credential, and the request returns before that use has stopped.
export async function removeConnection(actor,id) {
    const connection=owned(actor,id);
    if (adapterFor(connection).supportsAccountLink) {
        const {disconnectAccount}=await import('./codex/account.js');
        try { await disconnectAccount(actor,connection); } catch { /* removal proceeds even when the sign-out fails */ }
    }
    return deleteConnection(actor,id);
}

export function requireAiFeatureAccess(actor,feature) {
    const policy=settings(); eligible(actor,policy);
    const prefs=preferences(actor);
    if (!policy.enabled || !prefs.enabled) throw aiError('AI_DISABLED',403);
    if (feature !== 'setup' && (!FEATURES.includes(feature) || !policy.functions.includes(feature))) throw aiError('AI_FORBIDDEN',403);
    return {settings:policy,preferences:prefs};
}
// A connection whose provider links a personal account is only usable while
// that account is actually linked for this owner. An expired or removed sign-in
// means signing in again, never a fallback to another provider or credential.
export function requireLinkedAccount(connection) {
    if (!adapterFor(connection).supportsAccountLink) return;
    if (!readCredentialRecord(connection.owner_key,connection.id)) throw aiError('AI_CODEX_NOT_LINKED',409);
    const readiness=codexReadinessSnapshot();
    if (!readiness.available) throw aiError(readiness.reason,503);
}
// Owner-only handle used by the account-link endpoints. `requirePolicy` applies
// the same server enablement and allowed-user gate as every other setup path;
// it is relaxed only for cancelling an attempt and for disconnecting, so a
// revoked account can never be stranded with a stored sign-in it cannot remove.
export function ownedAccountConnection(actor,id,{requirePolicy=true}={}) {
    if (requirePolicy) requireAiFeatureAccess(actor,'setup');
    const connection=owned(actor,id);
    if (!adapterFor(connection).supportsAccountLink) throw aiError('AI_INVALID_INPUT');
    return connection;
}
// Identity of the account currently linked to a connection, used to bind a
// stored job so a re-link to a different account cannot silently continue it.
export function accountBinding(connectionId) {
    const connection=loadConnection(connectionId);
    if (!connection || !adapterFor(connection).supportsAccountLink) return null;
    const record=readCredentialRecord(connection.owner_key,connection.id);
    // Only the account identity binds the job. The record version advances every
    // time a refreshed token is sealed, including twice during the job's own
    // turn, so comparing it would discard an answer that was already billed.
    return {hash:record?.account_hash ?? null,linked:Boolean(record)};
}
export function requireLinkedConnection(connectionId) {
    const connection=loadConnection(connectionId);
    if (connection) requireLinkedAccount(connection);
}
export function connectionProvider(connectionId) {
    const connection=loadConnection(connectionId);
    return connection ? providerOf(connection) : null;
}
export function allowsUnattendedWork(connectionId) {
    const connection=loadConnection(connectionId);
    return connection ? adapterFor(connection).allowsUnattended !== false : false;
}
export function requireAiAccess(actor,feature,connectionId=null,{requireModel=true}={}) {
    const {settings:policy,preferences:prefs}=requireAiFeatureAccess(actor,feature);
    const connection=loadConnection(connectionId || prefs.connection_id);
    if (!canUse(actor,connection,policy)) throw aiError('AI_FORBIDDEN',403);
    if (!connection.enabled) throw aiError('AI_DISABLED',403);
    if (feature !== 'setup' && !connection.functions.includes(feature)) throw aiError('AI_FORBIDDEN',403);
    const model=connection.owner_key === ownerKey(actor) && prefs.connection_id===connection.id ? prefs.model_id || connection.model_id : connection.model_id;
    if (feature !== 'setup' && (requireModel || feature !== 'diagnose') && (!model || !testedProfile(connection,model))) throw aiError('AI_MODEL_REQUIRED');
    return {connection:publicConnection(connection,actor),preferences:{...prefs,model_id:model},settings:policy,owner_key:ownerKey(actor)};
}

export function pruneUsage() {
    db.prepare("DELETE FROM ai_usage WHERE id IN (SELECT id FROM ai_usage WHERE status <> 'running' AND created_at < ? ORDER BY created_at LIMIT 100)")
        .run(Date.now()-30*86400000);
}

function reserve(access,feature,model,timeout=AI_TIMEOUT_MS) {
    return db.transaction(()=>{
        const now=Date.now();
        // A crashed worker's reservation expires only after its own strict request
        // deadline. Records written before providers had separate deadlines fall
        // back to the API transport's timeout.
        db.prepare("UPDATE ai_usage SET status='unknown' WHERE status='running' AND COALESCE(expires_at,created_at+?)<?").run(AI_TIMEOUT_MS+10000,now);
        const recent=db.prepare('SELECT status,error_code FROM ai_usage WHERE connection_id=? AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 3').all(access.connection.id,now-300000);
        if (recent.length===3 && recent.every(row=>['AI_UNAVAILABLE','AI_TIMEOUT'].includes(row.error_code))) throw aiError('AI_PAUSED',429);
        if (db.prepare("SELECT count(*) AS n FROM ai_usage WHERE status='running' AND (owner_key=? OR connection_id=?)").get(access.owner_key,access.connection.id).n) throw aiError('AI_BUSY',409);
        const limits=db.prepare('SELECT SUM(owner_key=?) AS owner_count,SUM(connection_id=?) AS connection_count,SUM(owner_key=? AND feature=?) AS feature_count FROM ai_usage WHERE created_at>?').get(access.owner_key,access.connection.id,access.owner_key,feature,now-3600000);
        if (limits.owner_count>=60 || limits.connection_count>=180 || limits.feature_count>=30) throw aiError('AI_RATE_LIMIT',429);
        pruneUsage();
        const id=randomUUID();
        db.prepare("INSERT INTO ai_usage(id,owner_key,connection_id,feature,model,status,created_at,expires_at) VALUES(?,?,?,?,?,'running',?,?)").run(id,access.owner_key,access.connection.id,feature,model,now,now+timeout+10000);
        return id;
    }).immediate();
}
// One orchestrator for every provider: the same reservation, call budget, outage
// breaker, connection-version checks and usage bookkeeping. Providers only
// supply the transport and return a normalized result.
async function call(actor,feature,connectionId,operation,payload,signal,validate) {
    const access=requireAiAccess(actor,feature,connectionId), connection=loadConnection(access.connection.id);
    // Gated on the billable path only: local reads of stored results stay
    // independent of the current sign-in state.
    requireLinkedAccount(connection);
    const model=payload?.model || null;
    const reservation=reserve(access,feature,model,providerTimeout(connection,operation));
    try {
        const response=await adapterFor(connection).execute({
            connection,settings:access.settings,ownerKey:access.owner_key,operation,payload,signal,
            beforeSend:()=>{
                const current=requireAiAccess(actor,feature,connection.id);
                if (current.connection.version !== access.connection.version || JSON.stringify(current.settings)!==JSON.stringify(access.settings)) throw aiError('AI_CONNECTION_CHANGED',409);
            }
        });
        const usage=response.usage || {prompt_tokens:null,completion_tokens:null};
        db.prepare('UPDATE ai_usage SET prompt_tokens=?,completion_tokens=? WHERE id=?').run(usage.prompt_tokens,usage.completion_tokens,reservation);
        const current=requireAiAccess(actor,feature,connection.id);
        if (current.connection.version !== access.connection.version) throw aiError('AI_CONNECTION_CHANGED',409);
        const data=validate(response.result);
        db.prepare("UPDATE ai_usage SET status='completed' WHERE id=?").run(reservation);
        return {data,model,usage};
    } catch(error) {
        const reason=signal?.reason?.code;
        const code=signal?.aborted ? /^ai_[a-z0-9_]+$/i.test(reason || '') ? reason.toUpperCase() : 'AI_CANCELLED' : error.code || 'AI_UNAVAILABLE';
        db.prepare("UPDATE ai_usage SET status=?,error_code=? WHERE id=?").run(error.code==='AI_TIMEOUT'?'unknown':'failed',code,reservation);
        if (error.code==='AI_MODEL_UNAVAILABLE' && feature!=='setup') {
            const current=loadConnection(connection.id);
            if (current?.version===connection.version && current.capabilities[model]) {
                current.capabilities[model]={...current.capabilities[model],chat:false,status:'unavailable'};
                if(current.model_id===model) current.model_id=null;
                db.transaction(()=>{persist(current,current.version);clearModelSelection(current.id,model);})();
                Object.defineProperty(error,'invalidatedConnectionVersion',{value:current.version});
            }
        }
        throw error;
    }
}
// Structured output is validated locally against the same feature contract for
// every provider; a provider's own schema support is never taken on trust.
function parseStructured(result,schema) {
    const content=result?.content;
    if (typeof content!=='string' || !content.trim()) throw aiError('AI_INVALID_RESPONSE',502);
    let data; try { data=JSON.parse(content); } catch { throw aiError('AI_INVALID_RESPONSE',502); }
    if (!validateJson(data,schema)) throw aiError('AI_INVALID_RESPONSE',502);
    return data;
}

export async function discoverModels(actor,id) {
    owned(actor,id);
    const c=loadConnection(id);
    const result=await call(actor,'setup',id,'models',null,null,response=>{
        const models=response?.models;
        if (!Array.isArray(models) || models.length>500 || models.some(model=>!model || typeof model.id!=='string' || !MODEL_ID.test(model.id))
            || new Set(models.map(model=>model.id)).size!==models.length) throw aiError('AI_INVALID_RESPONSE',502);
        return models.map(model=>({id:model.id,candidate:['text','other','unknown'].includes(model.candidate) ? model.candidate : 'unknown',
            ...(model.display_name ? {display_name:String(model.display_name).slice(0,120)} : {}),
            ...(model.is_default ? {is_default:true} : {})}));
    });
    c.models=result.data; persist(c,c.version); return publicConnection(c,actor);
}
export async function testModels(actor,id,input) {
    const c=owned(actor,id); inputObject(input);
    if (!Array.isArray(input.model_ids) || !input.model_ids.length || input.model_ids.length>3 || new Set(input.model_ids).size!==input.model_ids.length || input.model_ids.some(model=>typeof model!=='string' || !MODEL_ID.test(model))) throw aiError('AI_INVALID_INPUT');
    const usesTokenParameter=adapterFor(c).usesTokenParameter;
    const models=[];
    for (const model of input.model_ids) {
        const profile={id:model,chat:false,structured:false,status:'unverified',tested_at:Date.now(),token_parameter:usesTokenParameter ? c.token_parameter : null};
        for (const structured of [false,true]) {
            if (structured && !profile.chat) break;
            // Only a provider with a token-limit parameter can earn the single
            // documented alternate-parameter probe.
            for (let attempt=0;attempt<(structured || !usesTokenParameter ? 1 : 2);attempt++) {
                try {
                    await call(actor,'setup',id,'chat',{model,messages:[{role:'user',content:'Synthetic compatibility check: return {"ok":true}.'}],
                        schema:TEST_SCHEMA,structured,maxTokens:128,tokenParameter:profile.token_parameter},null,response=>{
                        const data=parseStructured(response,TEST_SCHEMA);
                        if (data.ok!==true) throw aiError('AI_INVALID_RESPONSE',502);
                        return data;
                    });
                    if (structured) profile.structured=true; else profile.chat=true;
                    profile.status='compatible'; delete profile.error_code;
                    break;
                } catch(error) {
                    if (!['AI_MODEL_UNAVAILABLE','AI_CAPABILITY_UNSUPPORTED','AI_TOKEN_PARAMETER_UNSUPPORTED','AI_INVALID_RESPONSE','AI_RESPONSE_TOO_LARGE'].includes(error.code)) throw error;
                    if (!structured && attempt===0 && usesTokenParameter && error.code==='AI_TOKEN_PARAMETER_UNSUPPORTED' && error.parameter===profile.token_parameter) {
                        profile.token_parameter=profile.token_parameter==='max_tokens'?'max_completion_tokens':'max_tokens';
                        continue;
                    }
                    profile.error_code=error.code;
                    profile.status=profile.chat ? 'json_fallback' : ['AI_MODEL_UNAVAILABLE','AI_CAPABILITY_UNSUPPORTED','AI_TOKEN_PARAMETER_UNSUPPORTED'].includes(error.code) ? 'incompatible' : 'unverified';
                    break;
                }
            }
        }
        models.push(profile);
    }
    // Remove replacements first so only new IDs evict unrelated profiles.
    for (const profile of models) delete c.capabilities[profile.id];
    // Reserve room for this explicit batch even if the wall clock moved backward.
    c.capabilities=retainedProfiles(c,MAX_MODEL_PROFILES-models.length);
    for (const profile of models) c.capabilities[profile.id]=profile;
    persist(c,c.version);
    const compatible=models.filter(model=>model.chat);
    // A catalog default is only a recommendation once it actually passed a test.
    const catalogDefault=(c.models||[]).find(entry=>entry?.is_default)?.id;
    return {models,recommended_model_id:compatible.find(model=>model.id===c.model_id)?.id
        || compatible.find(model=>model.id===catalogDefault)?.id || compatible[0]?.id || null};
}
export async function runInference(actor,feature,{messages,schema,signal,connectionId}={}) {
    const access=requireAiAccess(actor,feature,connectionId), c=loadConnection(access.connection.id), model=access.preferences.model_id;
    return call(actor,feature,c.id,'chat',{model,messages,schema,structured:c.capabilities[model].structured,maxTokens:2048},signal,
        response=>parseStructured(response,schema));
}
