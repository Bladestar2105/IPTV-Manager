import { clearChannelsCache } from './cacheService.js';
import { immediateTransaction, runWriteWithRetry } from '../database/sqliteWrites.js';

const now = () => Math.floor(Date.now() / 1000);
class QueueError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const fail = (message, status = 400) => new QueueError(message,status);
const owner = value => value == null ? null : Number(value);
const publicJob = row => ({
  id: row.id, type: row.type, target_id: row.target_id, user_id: row.user_id,
  status: row.status, created_at: row.created_at, updated_at: row.updated_at,
  ...(row.result ? { result: JSON.parse(row.result) } : {}),
  ...(row.error ? { error: row.error } : {}),
});

// All writes use the latency connection. Retry timers yield to HTTP/stream work;
// the existing retry helper bounds 48 attempts to approximately one minute.
const write = operation => runWriteWithRetry(operation, { attempts: 48, baseDelayMs: 50, label: 'maintenance queue' });

export function createMaintenanceQueue(database, runners) {
  function authorize(actor) {
    const admin = actor?.is_admin === true && database.prepare(
      'SELECT is_active,token_version FROM admin_users WHERE id=?').get(actor.id);
    if (!admin || Number(admin.is_active) !== 1 || admin.token_version !== actor.token_version) {
      throw fail('Administrator authorization was revoked or is missing', 403);
    }
  }

  function target(spec) {
    const table = spec.type === 'epg_source' ? 'epg_sources' : 'providers';
    const row = database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(spec.target_id);
    if (!row) throw fail('Maintenance target no longer exists', 404);
    if (spec.type === 'provider_sync') {
      if (!database.prepare('SELECT id FROM users WHERE id=?').get(spec.user_id)) {
        throw fail('Target user no longer exists', 404);
      }
      const config = database.prepare('SELECT id,granted_by_admin FROM sync_configs WHERE provider_id=? AND user_id=?')
        .get(spec.target_id, spec.user_id);
      return { owner: owner(row.user_id), grant: Number(config?.granted_by_admin) === 1, config_id: config?.id ?? null };
    }
    return { owner: spec.type === 'provider_epg' ? owner(row.user_id) : null };
  }

  async function enqueue(actor, specs) {
    if (!Array.isArray(specs) || specs.length > 1000) throw fail('Expected at most 1000 maintenance jobs');
    return write(immediateTransaction(database, () => {
      authorize(actor);
      const jobs = [];
      for (const spec of specs) {
        if (!['provider_sync','epg_source','provider_epg'].includes(spec.type)
          || !Number.isSafeInteger(spec.target_id) || spec.target_id < 1
          || (spec.type === 'provider_sync' && (!Number.isSafeInteger(spec.user_id) || spec.user_id < 1))) {
          throw fail('Invalid maintenance job');
        }
        const options = {
          allow_cross_owner: spec.allow_cross_owner === true,
          restore_revoked_assignments: spec.restore_revoked_assignments === true,
          skip_prune: spec.skip_prune === true,
        };
        const snapshot = target(spec);
        if (spec.type === 'provider_sync' && snapshot.owner !== spec.user_id && !snapshot.grant && !options.allow_cross_owner) {
          throw fail('Cross-owner sync requires explicit administrator approval', 403);
        }
        const userId = spec.type === 'provider_sync' ? spec.user_id : null;
        const key = JSON.stringify([actor.id,actor.token_version,spec.type,spec.target_id,userId,options]);
        let row = database.prepare("SELECT * FROM maintenance_jobs WHERE dedupe_key=? AND status IN ('queued','running')").get(key);
        if (!row) {
          if (database.prepare("SELECT COUNT(*) AS count FROM maintenance_jobs WHERE status IN ('queued','running')").get().count >= 1000) {
            throw fail('Maintenance queue is full; retry after jobs finish', 503);
          }
          const timestamp = now();
          const inserted = database.prepare(`INSERT INTO maintenance_jobs
            (actor_id,token_version,type,target_id,user_id,options,snapshot,dedupe_key,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(actor.id,actor.token_version,spec.type,spec.target_id,userId,
            JSON.stringify(options),JSON.stringify(snapshot),key,timestamp,timestamp);
          row = database.prepare('SELECT * FROM maintenance_jobs WHERE id=?').get(inserted.lastInsertRowid);
        }
        jobs.push(publicJob(row));
      }
      return jobs;
    }));
  }

  async function list(actor) {
    authorize(actor);
    return database.prepare(`SELECT * FROM maintenance_jobs WHERE actor_id=? AND
      (status IN ('queued','running') OR updated_at >= ?) ORDER BY (status IN ('queued','running')) DESC,id DESC LIMIT 1100`)
      .all(actor.id,now()-7*86400).map(publicJob);
  }

  async function drain() {
    const job = await write(immediateTransaction(database, () => {
      const timestamp = now();
      database.prepare(`UPDATE maintenance_jobs SET status='error',error=?,updated_at=?,lease_until=NULL
        WHERE status='running' AND lease_until <= ?`)
        .run('Worker stopped or its lease expired; review the outcome before retrying',timestamp,timestamp);
      database.prepare(`DELETE FROM maintenance_jobs WHERE id IN (SELECT id FROM maintenance_jobs
        WHERE status NOT IN ('queued','running') AND updated_at < ? LIMIT 100)`)
        .run(timestamp-7*86400);
      if (database.prepare("SELECT id FROM maintenance_jobs WHERE status='running'").get()) return null;
      const row = database.prepare("SELECT * FROM maintenance_jobs WHERE status='queued' AND available_at <= ? ORDER BY id LIMIT 1").get(timestamp);
      if (!row) return null;
      database.prepare("UPDATE maintenance_jobs SET status='running',updated_at=?,lease_until=? WHERE id=?")
        .run(timestamp,timestamp+900,row.id);
      return row;
    }));
    if (!job) return;
    const defer = () => write(() => database.prepare(`UPDATE maintenance_jobs SET status='queued',available_at=?,
      updated_at=?,lease_until=NULL WHERE id=? AND status='running'`).run(now()+5,now(),job.id));
    const heartbeat = setInterval(() => {
      write(() => database.prepare("UPDATE maintenance_jobs SET lease_until=? WHERE id=? AND status='running'")
        .run(now()+900,job.id)).catch(() => {});
    },60000);
    heartbeat.unref?.();
    let status = 'success', result = null, error = null;
    try {
      const services = runners || {
        ...(await import('./syncService.js')), ...(await import('./epgService.js')),
      };
      const actor = {id:job.actor_id,token_version:job.token_version,is_admin:true};
      authorize(actor);
      const snapshot = JSON.parse(job.snapshot), current = target(job), options = JSON.parse(job.options);
      if (current.owner !== snapshot.owner || (snapshot.grant && (!current.grant || current.config_id !== snapshot.config_id))) {
        throw fail('Queued maintenance authorization changed',403);
      }
      if (job.type === 'provider_sync') {
        const outcome = await services.performSync(job.target_id,job.user_id,{
          mode:'manual',actor,allowCrossOwner:options.allow_cross_owner,
          restoreRevokedAssignments:options.restore_revoked_assignments,
          queuedExpectation:snapshot,
        });
        if (outcome.status === 'locked') {
          await defer();
          return;
        }
        if (!['success','partial'].includes(outcome.status)) throw fail('Provider synchronization failed');
        status = outcome.status;
        result = {channels_added:Number(outcome.channelsAdded)||0,channels_updated:Number(outcome.channelsUpdated)||0,
          categories_added:Number(outcome.categoriesAdded)||0};
        if (status === 'partial') result.warning = 'Some provider catalog data could not be updated';
        try { await services.updateProviderEpg(job.target_id); }
        catch (e) {
          status = 'partial';
          if (e.code === 'EPG_UPDATE_LOCKED') {
            try {
              await enqueue(actor,[{type:'provider_epg',target_id:job.target_id}]);
              result.warning = 'Catalog synchronized; EPG update queued';
            } catch {
              result.warning = 'Catalog synchronized; EPG update could not be queued';
            }
          } else result.warning = 'Catalog synchronized; EPG update failed';
        }
      } else if (job.type === 'epg_source') {
        await services.updateEpgSource(job.target_id,options.skip_prune);
      } else {
        await services.updateProviderEpg(job.target_id,options.skip_prune);
      }
    } catch (e) {
      if (e.code === 'EPG_UPDATE_LOCKED') { await defer(); return; }
      status = 'error';
      // Only locally generated errors are safe for clients; upstream errors can
      // contain credentials, query strings and response bodies.
      error = e instanceof QueueError ? e.message : 'Maintenance failed; check the server logs';
    } finally {
      clearInterval(heartbeat);
    }
    if (status === 'success' || status === 'partial') clearChannelsCache(undefined, {epg: true});
    await write(() => database.prepare(`UPDATE maintenance_jobs SET status=?,result=?,error=?,updated_at=?,lease_until=NULL
      WHERE id=? AND status='running'`).run(status,result ? JSON.stringify(result) : null,error,now(),job.id));
  }
  return {enqueue,list,drain};
}

let queuePromise, timer, draining = false;
async function defaultQueue() {
  if (!queuePromise) queuePromise = import('../database/db.js')
    .then(({openLatencyDbConnection}) => createMaintenanceQueue(openLatencyDbConnection()))
    .catch(error => { queuePromise = undefined; throw error; });
  return queuePromise;
}
export async function enqueueMaintenanceJobs(actor,specs) { return (await defaultQueue()).enqueue(actor,specs); }
export async function listMaintenanceJobs(actor) { return (await defaultQueue()).list(actor); }
export function startMaintenanceQueue() {
  if (timer) return;
  const tick = async () => {
    if (draining) return;
    draining = true;
    try { await (await defaultQueue()).drain(); }
    catch { console.warn('Maintenance queue bookkeeping failed; retrying on next tick'); }
    finally { draining = false; }
  };
  timer = setInterval(tick,5000); timer.unref?.();
  void tick();
}
