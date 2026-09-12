import { randomUUID } from 'node:crypto';
import db from '../../database/db.js';
import { requireAiAccess, requireAiFeatureAccess, runInference, pruneUsage } from './connections.js';
import { safeText } from './context.js';

const FEATURES = ['list','cleanup','duplicates','epg','sync','search','diagnose','text'];
const JOB_TIMEOUT = 120000;
const LARGE_JOB_TIMEOUT = 600000;
const HISTORY_AGE = 7 * 86400000;
const running = new Map();

function fail(status, code) {
  throw Object.assign(new Error(code), {status, code});
}

export function ownerKey(actor) {
  return `${actor.is_admin ? 'admin' : 'user'}:${actor.id}`;
}

function currentActor(actor, expectedVersion) {
  const table = actor.is_admin ? 'admin_users' : 'users';
  const row = db.prepare(`SELECT id, username, is_active, token_version${actor.is_admin ? '' : ', webui_access'} FROM ${table} WHERE id = ?`).get(actor.id);
  if (!row || !row.is_active || (!actor.is_admin && !row.webui_access) ||
      (expectedVersion !== undefined && row.token_version !== expectedVersion)) fail(403,'ai_access_revoked');
  return {...row,is_admin:!!actor.is_admin};
}

function normalizeInput(actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !FEATURES.includes(input.feature)) fail(400,'ai_invalid_input');
  if (JSON.stringify(input).length > 32768 ||
      (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 4000))) fail(400,'ai_invalid_input');
  const userId = input.user_id == null ? (actor.is_admin ? null : actor.id) : Number(input.user_id);
  if ((!actor.is_admin && userId !== actor.id) ||
      (userId !== null && (!Number.isSafeInteger(userId) || userId <= 0))) fail(403,'ai_access_denied');
  if (userId === null && input.feature !== 'diagnose') fail(400,'ai_user_required');
  if (userId !== null && !db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(userId)) fail(403,'ai_access_denied');
  const clean = {...input,user_id:userId};
  for (const key of Object.keys(clean)) if (key.startsWith('_') || key === 'idempotency_key') delete clean[key];
  const allowed = ['feature','user_id','prompt','language','timezone','connection_id','conversation_id','category_id',
    'selected_ids','pinned_ids','keep_first','channel_ids','provider_channel_id','operation','program','filters','full_list','offset','snapshot_id'];
  if (Object.keys(clean).some(key => !allowed.includes(key)) ||
      (clean.full_list !== undefined && typeof clean.full_list !== 'boolean')) fail(400,'ai_invalid_input');
  if (clean.prompt !== undefined) clean.prompt = safeText(clean.prompt,4000);
  return clean;
}

function expireJobs() {
  // A sent request may have been billed. A lost worker never causes replay.
  db.prepare(`UPDATE ai_jobs SET status = 'failed', error_code = CASE WHEN request_started_at IS NULL
      THEN 'ai_interrupted' ELSE 'ai_request_uncertain' END, updated_at = ?
    WHERE status = 'running' AND updated_at < ? - COALESCE(json_extract(input_json,'$._timeout'),120000) - 5000`).run(Date.now(),Date.now());
  db.prepare("UPDATE ai_jobs SET status = 'failed', error_code = 'ai_interrupted', updated_at = ? WHERE status = 'queued' AND created_at < ?")
    .run(Date.now(),Date.now() - 3 * LARGE_JOB_TIMEOUT);
  db.prepare("DELETE FROM ai_jobs WHERE id IN (SELECT id FROM ai_jobs WHERE status NOT IN ('running','queued') AND updated_at < ? LIMIT 100)")
    .run(Date.now() - HISTORY_AGE);
  pruneUsage();
}

function scheduleJob(id) {
  setImmediate(() => runJob(id).catch(() => {}));
}

export function createJob(actor, input, idempotencyKey = randomUUID()) {
  const fresh = currentActor(actor);
  const payload = normalizeInput(fresh,input);
  if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) fail(400,'ai_invalid_idempotency_key');
  const access = requireAiAccess(fresh,payload.feature,payload.connection_id || null,{requireModel:payload.feature !== 'diagnose'});
  payload.language ??= access.preferences.language;
  payload.timezone ??= access.preferences.timezone;
  const inputJson = JSON.stringify({...payload,connection_id:access.connection.id,_timeout:payload.full_list === true ? LARGE_JOB_TIMEOUT : JOB_TIMEOUT,
    _actor_version:fresh.token_version,_model_id:access.preferences.model_id || access.connection.model_id});
  expireJobs();
  const row = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM ai_jobs WHERE owner_key = ? AND idempotency_key = ?').get(ownerKey(fresh),idempotencyKey);
    if (existing) {
      if (existing.input_json !== inputJson) fail(409,'ai_idempotency_conflict');
      return existing;
    }
    const active = db.prepare("SELECT owner_key, connection_id FROM ai_jobs WHERE status IN ('queued','running')").all();
    if (active.filter(job => job.owner_key === ownerKey(fresh)).length >= 2 ||
        active.filter(job => job.connection_id === access.connection.id).length >= 3 || active.length >= 20) fail(429,'ai_busy');
    const now = Date.now();
    const id = randomUUID();
    db.prepare(`INSERT INTO ai_jobs
      (id,owner_key,user_id,feature,connection_id,connection_version,status,input_json,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued',?,?,?,?)`).run(id,ownerKey(fresh),payload.user_id,payload.feature,
      access.connection.id,access.connection.version,inputJson,idempotencyKey,now,now);
    return db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(id);
  }).immediate();
  if (row.status === 'queued') scheduleJob(row.id);
  return {id:row.id,status:row.status,feature:row.feature,created_at:row.created_at};
}

async function runJob(id) {
  const claimed = db.transaction(() => {
    const candidate = db.prepare("SELECT owner_key,connection_id FROM ai_jobs WHERE id = ? AND status = 'queued'").get(id);
    if (!candidate || db.prepare("SELECT 1 FROM ai_jobs WHERE status = 'running' AND (owner_key = ? OR connection_id = ?)").get(candidate.owner_key,candidate.connection_id)) return false;
    return db.prepare("UPDATE ai_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(),id).changes;
  }).immediate();
  if (!claimed) return;
  const job = db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(id);
  const input = JSON.parse(job.input_json);
  const [kind,actorId] = job.owner_key.split(':');
  const actor = {id:Number(actorId),is_admin:kind === 'admin'};
  const controller = new AbortController();
  running.set(id,controller);
  const deadline = setTimeout(() => controller.abort(),input._timeout || JOB_TIMEOUT);
  const check = (requireModel = job.feature !== 'diagnose') => {
    if (controller.signal.aborted) fail(409,'ai_cancelled');
    const state = db.prepare('SELECT status FROM ai_jobs WHERE id = ?').get(id);
    if (state?.status !== 'running') fail(409,'ai_cancelled');
    const fresh = currentActor(actor,input._actor_version);
    normalizeInput(fresh,input);
    const access = requireAiAccess(fresh,job.feature,job.connection_id,{requireModel});
    const model = access.preferences.model_id || access.connection.model_id;
    if (access.connection.version !== job.connection_version ||
        (model !== input._model_id && (job.feature !== 'diagnose' || model))) fail(409,'ai_connection_changed');
    return fresh;
  };
  const monitor = setInterval(() => {
    try { check(); } catch { controller.abort(); }
  },500);
  monitor.unref();
  try {
    check();
    const {executeFeature,authorizeResult} = await import('./features.js');
    const result = await executeFeature(actor,input,{
      signal:controller.signal,jobId:id,
      infer:async ({messages,schema}) => {
        const fresh = check(true);
        db.prepare('UPDATE ai_jobs SET request_started_at = ? WHERE id = ?').run(Date.now(),id);
        let response;
        try {
          response = await runInference(fresh,job.feature,{messages,schema,signal:controller.signal,connectionId:job.connection_id});
        } catch (error) {
          // Only this request's successful model invalidation advances the expected snapshot.
          if (job.feature === 'diagnose' && error.code === 'AI_MODEL_UNAVAILABLE' &&
              error.invalidatedConnectionVersion === job.connection_version + 1) job.connection_version = error.invalidatedConnectionVersion;
          throw error;
        }
        check();
        return response;
      }
    });
    const fresh = check();
    await authorizeResult(fresh,input,result);
    check();
    const output = JSON.stringify(result);
    if (output.length > 512000) fail(422,'ai_result_too_large');
    db.prepare("UPDATE ai_jobs SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(output,Date.now(),id);
  } catch (error) {
    const code = controller.signal.aborted ? 'ai_cancelled' :
      (/^ai_[a-z0-9_]+$/i.test(error.code || '') ? error.code : 'ai_job_failed');
    db.prepare("UPDATE ai_jobs SET status = ?, error_code = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(controller.signal.aborted ? 'cancelled' : 'failed',code,Date.now(),id);
  } finally {
    clearTimeout(deadline);
    clearInterval(monitor);
    running.delete(id);
    for (const next of db.prepare("SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 20").all()) scheduleJob(next.id);
  }
}

export async function getJob(actor, id) {
  expireJobs();
  const row = db.prepare("SELECT * FROM ai_jobs WHERE id = ? AND owner_key = ? AND (status IN ('running','queued') OR updated_at >= ?)").get(id,ownerKey(actor),Date.now()-HISTORY_AGE);
  if (!row) fail(404,'ai_not_found');
  const fresh = currentActor(actor);
  const output = {id:row.id,status:row.status,feature:row.feature,created_at:row.created_at,updated_at:row.updated_at,error_code:row.error_code};
  if (row.result_json) {
    requireAiFeatureAccess(fresh,row.feature);
    const {authorizeResult} = await import('./features.js');
    output.result = await authorizeResult(fresh,JSON.parse(row.input_json),JSON.parse(row.result_json));
    if (output.result && typeof output.result === 'object') delete output.result._authorization;
  }
  if (row.status === 'queued') scheduleJob(row.id);
  return output;
}

export function listJobs(actor) {
  currentActor(actor);
  expireJobs();
  return db.prepare("SELECT id,status,feature,error_code,created_at,updated_at FROM ai_jobs WHERE owner_key = ? AND (status IN ('running','queued') OR updated_at >= ?) ORDER BY created_at DESC LIMIT 50").all(ownerKey(actor),Date.now()-HISTORY_AGE);
}

export function cancelJob(actor, id) {
  const row = db.prepare('SELECT id,status FROM ai_jobs WHERE id = ? AND owner_key = ?').get(id,ownerKey(actor));
  if (!row) fail(404,'ai_not_found');
  db.prepare("UPDATE ai_jobs SET status = 'cancelled', error_code = 'ai_cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')")
    .run(Date.now(),id);
  running.get(id)?.abort();
  return {id,status:db.prepare('SELECT status FROM ai_jobs WHERE id = ?').get(id).status};
}

export function clearHistory(actor) {
  const key = ownerKey(currentActor(actor));
  for (const row of db.prepare("SELECT id FROM ai_jobs WHERE owner_key = ? AND status IN ('queued','running')").all(key)) cancelJob(actor,row.id);
  db.transaction(() => {
    for (const table of ['ai_jobs','ai_conversations','ai_enrichments']) db.prepare(`DELETE FROM ${table} WHERE owner_key = ?`).run(key);
  })();
  return {success:true};
}

export function getUsage(actor) {
  currentActor(actor);
  expireJobs();
  const rows = db.prepare(`SELECT connection_id,feature,model,status,prompt_tokens,completion_tokens,created_at
    FROM ai_usage WHERE owner_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 200`)
    .all(ownerKey(actor),Date.now() - 30 * 86400000);
  return {calls:rows.length,prompt_tokens:rows.some(r => r.prompt_tokens === null) ? null : rows.reduce((s,r) => s + r.prompt_tokens,0),
    completion_tokens:rows.some(r => r.completion_tokens === null) ? null : rows.reduce((s,r) => s + r.completion_tokens,0),
    price:null,window_days:30,truncated:rows.length === 200,requests:rows};
}
