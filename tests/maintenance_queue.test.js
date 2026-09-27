import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { clearChannelsCache } from '../src/services/cacheService.js';
vi.mock('../src/services/cacheService.js', () => ({clearChannelsCache: vi.fn()}));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateMaintenanceQueue } from '../src/database/maintenanceQueueSchema.js';
import { createMaintenanceQueue } from '../src/services/maintenanceQueueService.js';

let dir, db, second, queue, runners;
const actor = { id: 1, is_admin: true, token_version: 0 };
const spec = { type: 'provider_sync', target_id: 1, user_id: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'maintenance-'));
  db = new Database(join(dir, 'db.sqlite'));
  db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=1');
  db.exec(`CREATE TABLE admin_users(id INTEGER, is_active INTEGER, token_version INTEGER);
    INSERT INTO admin_users VALUES(1,1,0);
    CREATE TABLE users(id INTEGER); INSERT INTO users VALUES(1),(2);
    CREATE TABLE providers(id INTEGER, user_id INTEGER); INSERT INTO providers VALUES(1,1),(2,1);
    CREATE TABLE sync_configs(id INTEGER, provider_id INTEGER, user_id INTEGER, granted_by_admin INTEGER);
    CREATE TABLE epg_sources(id INTEGER); INSERT INTO epg_sources VALUES(1);`);
  migrateMaintenanceQueue(db);
  second = new Database(join(dir, 'db.sqlite')); second.pragma('busy_timeout=1');
  runners = { performSync: vi.fn(async () => ({status:'success',channelsAdded:3})), updateProviderEpg: vi.fn(async () => {}), updateEpgSource: vi.fn(async () => {}) };
  queue = createMaintenanceQueue(db, runners);
});
afterEach(() => { db.close(); second.close(); rmSync(dir,{recursive:true,force:true}); });

describe('durable serial maintenance queue', () => {
  it('accepts an empty authorized batch', async () => {
    expect(await queue.enqueue(actor,[])).toEqual([]);
  });
  it('deduplicates identical requests but preserves distinct rights and exposes no actor data', async () => {
    const [a,b,c] = await queue.enqueue(actor,[spec,spec,{...spec,restore_revoked_assignments:true}]);
    expect(a.id).toBe(b.id); expect(c.id).not.toBe(a.id);
    expect(a).not.toHaveProperty('actor_id'); expect(a.status).toBe('queued');
  });
  it('claims FIFO and serializes runners across independent connections', async () => {
    await queue.enqueue(actor,[spec,{...spec,target_id:2}]);
    let release; runners.performSync.mockImplementationOnce(() => new Promise(resolve => {release=resolve;}));
    const running = queue.drain();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const other = createMaintenanceQueue(second,runners);
    await other.drain(); expect(runners.performSync).toHaveBeenCalledTimes(1);
    release({status:'success'}); await running; await other.drain();
    expect(runners.performSync.mock.calls.map(call=>call[0])).toEqual([1,2]);
    expect((await queue.list(actor)).every(job=>job.status==='success')).toBe(true);
  });
  it('yields while SQLite is busy and accepts only after durable commit', async () => {
    second.exec('BEGIN IMMEDIATE'); let accepted=false;
    const pending=queue.enqueue(actor,[spec]).then(value=>{accepted=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,30)); expect(accepted).toBe(false);
    second.exec('COMMIT'); expect((await pending)[0].status).toBe('queued');
  });
  it('rejects revoked actors and grants before running', async () => {
    db.exec('INSERT INTO sync_configs VALUES(1,1,2,1)');
    await queue.enqueue(actor,[{...spec,user_id:2,allow_cross_owner:true}]);
    db.exec('UPDATE sync_configs SET granted_by_admin=0');
    await queue.drain(); expect((await queue.list(actor))[0].status).toBe('error');
    expect(runners.performSync).not.toHaveBeenCalled();
    await queue.enqueue(actor,[spec]); db.exec('UPDATE admin_users SET token_version=1');
    await queue.drain(); expect(runners.performSync).not.toHaveBeenCalled();
    await expect(queue.enqueue(actor,[spec])).rejects.toThrow(/authorization/i);
  });
  it('retains queued work on restart and never replays an interrupted running job', async () => {
    const [a,b]=await queue.enqueue(actor,[spec,{...spec,target_id:2}]);
    db.prepare("UPDATE maintenance_jobs SET status='running',lease_until=0 WHERE id=?").run(a.id);
    await createMaintenanceQueue(second,runners).drain();
    const jobs=await queue.list(actor);
    expect(jobs.find(j=>j.id===a.id).status).toBe('error');
    expect(jobs.find(j=>j.id===b.id).status).toBe('success');
    expect(runners.performSync.mock.calls.map(call=>call[0])).toEqual([2]);
  });
  it('requeues lock contention and marks catalog success with EPG failure partial without secrets', async () => {
    await queue.enqueue(actor,[spec]); runners.performSync.mockResolvedValueOnce({status:'locked'});
    await queue.drain(); expect((await queue.list(actor))[0].status).toBe('queued');
    db.exec('UPDATE maintenance_jobs SET available_at=0');
    runners.updateProviderEpg.mockRejectedValueOnce(new Error('https://secret:password@host'));
    await queue.drain(); const [job]=await queue.list(actor);
    expect(job.status).toBe('partial'); expect(job.result.channels_added).toBe(3);
    expect(JSON.stringify(job)).not.toContain('password');
  });
  it('dispatches EPG jobs with skip-prune and checks target deletion', async () => {
    await queue.enqueue(actor,[{type:'epg_source',target_id:1,skip_prune:true},{type:'provider_epg',target_id:2}]);
    await queue.drain(); expect(runners.updateEpgSource).toHaveBeenCalledWith(1,true);
    expect(clearChannelsCache).toHaveBeenCalledWith(undefined, {epg: true});
    db.exec('DELETE FROM providers WHERE id=2'); await queue.drain();
    expect((await queue.list(actor)).find(j=>j.target_id===2).status).toBe('error');
  });
  it('rejects ownership transfer and never exposes upstream errors carrying HTTP status', async () => {
    await queue.enqueue(actor,[spec]); db.exec('UPDATE providers SET user_id=2 WHERE id=1');
    await queue.drain(); expect(runners.performSync).not.toHaveBeenCalled();
    await queue.enqueue(actor,[{type:'epg_source',target_id:1}]);
    runners.updateEpgSource.mockRejectedValueOnce(Object.assign(new Error('secret password'),{status:502}));
    await queue.drain(); expect(JSON.stringify(await queue.list(actor))).not.toContain('secret password');
  });

  it('bounds active capacity atomically and cleans old history in small batches', async () => {
    await queue.enqueue(actor,[spec]);
    db.exec(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<1000)
      INSERT INTO maintenance_jobs(actor_id,token_version,type,target_id,options,snapshot,dedupe_key,created_at,updated_at)
      SELECT 1,0,'provider_epg',1,'{}','{}','job-'||x,0,0 FROM n`);
    await expect(queue.enqueue(actor,[{type:'epg_source',target_id:1}])).rejects.toMatchObject({status:503});
    expect((await queue.enqueue(actor,[spec]))[0].status).toBe('queued');
    db.exec("UPDATE maintenance_jobs SET status='success' WHERE id>1");
    await queue.drain();
    expect(db.prepare('SELECT COUNT(*) AS n FROM maintenance_jobs').get().n).toBe(900);
  });

});

it('keeps an EPG task queued while a scheduled import owns its source lock', async () => {
  await queue.enqueue(actor,[{type:'epg_source',target_id:1}]);
  runners.updateEpgSource.mockRejectedValueOnce(Object.assign(new Error('held'), {code:'EPG_UPDATE_LOCKED'}));
  await queue.drain();
  expect((await queue.list(actor))[0].status).toBe('queued');
  db.exec('UPDATE maintenance_jobs SET available_at=0');
  await queue.drain();
  expect((await queue.list(actor))[0].status).toBe('success');
});

it('queues contended follow-up EPG without repeating a completed catalog sync', async () => {
  await queue.enqueue(actor,[spec]);
  runners.updateProviderEpg.mockRejectedValueOnce(Object.assign(new Error('held'), {code:'EPG_UPDATE_LOCKED'}));
  await queue.drain();
  const jobs = await queue.list(actor);
  expect(jobs.find(job=>job.type==='provider_sync').status).toBe('partial');
  expect(jobs.find(job=>job.type==='provider_epg').status).toBe('queued');
  await queue.drain();
  expect(runners.performSync).toHaveBeenCalledTimes(1);
  expect(runners.updateProviderEpg).toHaveBeenCalledTimes(2);
});
