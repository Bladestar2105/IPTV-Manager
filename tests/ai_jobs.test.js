import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// Exercise the persisted job/transport boundary. The feature itself is covered
// against real catalog data in ai_features.test.js.
vi.mock('../src/services/ai/features.js',()=>({
  executeFeature:async (actor,input,{infer})=>{
    const answer=await infer({messages:[{role:'user',content:'Synthetic check'}],schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}});
    return {feature:input.feature,summary:answer.data.ok?'Ready':'Failed',_authorization:{owner_key:`user:${actor.id}`}};
  },
  authorizeResult:(_actor,_input,result)=>result
}));

const dataDir=mkdtempSync(join(tmpdir(),'iptv-ai-jobs-'));
process.env.DATA_DIR=dataDir;
let db,api,jobs,actor,connection,server,requests=0,hold=false,pending=[];
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await pause();}throw new Error('Timed out waiting for synthetic job: '+JSON.stringify(db.prepare('SELECT status,error_code FROM ai_jobs').all()));};
const release=()=>{for(const send of pending.splice(0))send();};

beforeAll(async()=>{
  const database=await import('../src/database/db.js');db=database.default;database.initDb(true);
  api=await import('../src/services/ai/connections.js');jobs=await import('../src/services/ai/jobs.js');
  actor={id:Number(db.prepare("INSERT INTO admin_users(username,password) VALUES('job-admin','unused')").run().lastInsertRowid),is_admin:true};
  server=http.createServer(async(req,res)=>{
    for await(const _chunk of req) { /* Consume bounded synthetic fixture. */ }
    requests++;
    const send=()=>{if(res.destroyed)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}],usage:{prompt_tokens:3,completion_tokens:4}}));};
    if(hold)pending.push(send);else send();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/v1`;
  api.updateAiSettings(actor,{enabled:true,internal_targets:[base]});
  api.savePreferences(actor,{enabled:true});
  connection=api.saveConnection(actor,{name:'Test',base_url:base});
  await api.testModels(actor,connection.id,{model_ids:['fixture']});
  api.savePreferences(actor,{connection_id:connection.id,model_id:'fixture'});
  requests=0;
});
afterAll(async()=>{
  hold=false;release();await until(()=>!db.prepare("SELECT 1 FROM ai_jobs WHERE status IN ('queued','running')").get());
  await new Promise(resolve=>server.close(resolve));
  (await import('../src/database/epgDb.js')).default.close();
  db.close();rmSync(dataDir,{recursive:true,force:true});
});

describe('durable bounded AI jobs',()=>{
  it('claims duplicate deliveries once, keeps authorization evidence private and rejects key reuse with changed input',async()=>{
    const a=jobs.createJob(actor,{feature:'diagnose'},'same-job-key');
    const b=jobs.createJob(actor,{feature:'diagnose'},'same-job-key');
    expect(a.id).toBe(b.id);
    await until(()=>db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(a.id).status==='completed');
    const output=await jobs.getJob(actor,a.id);
    expect(output.result).toEqual({feature:'diagnose',summary:'Ready'});
    expect(JSON.parse(db.prepare('SELECT result_json FROM ai_jobs WHERE id=?').get(a.id).result_json)).toHaveProperty('_authorization');
    expect(requests).toBe(1);
    expect(()=>jobs.createJob(actor,{feature:'diagnose',prompt:'changed'},'same-job-key')).toThrow('ai_idempotency_conflict');
  });
  it('cancels an in-flight call without publishing its result',async()=>{
    hold=true;
    const job=jobs.createJob(actor,{feature:'diagnose'},'cancel-job-key');
    await until(()=>pending.length===1);
    expect(jobs.cancelJob(actor,job.id).status).toBe('cancelled');
    hold=false;release();
    await until(()=>db.prepare('SELECT status FROM ai_usage ORDER BY created_at DESC LIMIT 1').get().status!=='running');
    expect(await jobs.getJob(actor,job.id)).not.toHaveProperty('result');
    expect(await jobs.getJob(actor,job.id)).toMatchObject({status:'cancelled',error_code:'ai_cancelled'});
    expect(jobs.listJobs(actor).find(row=>row.id===job.id)).toMatchObject({status:'cancelled',error_code:'ai_cancelled'});
    expect(db.prepare('SELECT status,error_code FROM ai_usage ORDER BY created_at DESC LIMIT 1').get()).toEqual({status:'unknown',error_code:'AI_CANCELLED'});
  });
  it('records the overall deadline as a failure with uncertain usage, not a user cancellation',async()=>{
    hold=true;const count=requests;
    const job=jobs.createJob(actor,{feature:'diagnose'},'deadline-job-key');
    // Shorten only this persisted fixture's internal budget before its scheduled worker starts.
    db.prepare("UPDATE ai_jobs SET input_json=json_set(input_json,'$._timeout',150) WHERE id=?").run(job.id);
    await until(()=>pending.length===1);
    await until(()=>db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(job.id).status!=='running');
    hold=false;release();
    expect(await jobs.getJob(actor,job.id)).toMatchObject({status:'failed',error_code:'AI_TIMEOUT'});
    expect(jobs.listJobs(actor).find(row=>row.id===job.id)).toMatchObject({status:'failed',error_code:'AI_TIMEOUT'});
    expect(db.prepare('SELECT status,error_code FROM ai_usage ORDER BY created_at DESC LIMIT 1').get()).toEqual({status:'unknown',error_code:'AI_TIMEOUT'});
    expect(requests).toBe(count+1);
  });
  it('invalidates a completed response when its connection changes during inference',async()=>{
    hold=true;
    const job=jobs.createJob(actor,{feature:'diagnose'},'changed-job-key');
    await until(()=>pending.length===1);
    api.saveConnection(actor,{name:'Changed while running'},connection.id);
    hold=false;release();
    await until(()=>db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(job.id).status==='failed');
    expect((await jobs.getJob(actor,job.id)).error_code).toMatch(/connection_changed/i);
    expect(await jobs.getJob(actor,job.id)).not.toHaveProperty('result');
  });
  it('does not replay a possibly billed request after a lost worker',async()=>{
    const before=requests;
    const old=Date.now()-300000;
    db.prepare(`INSERT INTO ai_jobs (id,owner_key,feature,status,input_json,idempotency_key,created_at,updated_at,request_started_at)
      VALUES ('lost-worker',?,'diagnose','running','{}','lost-worker-key',?,?,?)`).run(`admin:${actor.id}`,old,old,old);
    expect(await jobs.getJob(actor,'lost-worker')).toMatchObject({status:'failed',error_code:'ai_request_uncertain'});
    expect(requests).toBe(before);
  });
  it('queues calls sharing a connection until the running job finishes',async()=>{
    hold=true;
    const first=jobs.createJob(actor,{feature:'diagnose'},'queued-first-key');
    await until(()=>pending.length===1);
    const second=jobs.createJob(actor,{feature:'diagnose'},'queued-second-key');
    await pause();
    expect(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(second.id).status).toBe('queued');
    expect(pending).toHaveLength(1);
    hold=false;release();
    await until(()=>db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE id IN (?,?) AND status='completed'").get(first.id,second.id).n===2);
  });
  it('keeps queued work available while an explicitly large analysis is running',async()=>{
    hold=true;
    const first=jobs.createJob(actor,{feature:'diagnose',full_list:true},'large-first-key');
    await until(()=>pending.length===1);
    const second=jobs.createJob(actor,{feature:'diagnose'},'large-second-key');
    db.prepare('UPDATE ai_jobs SET created_at=? WHERE id=?').run(Date.now()-300000,second.id);
    expect((await jobs.getJob(actor,second.id)).status).toBe('queued');
    hold=false;release();
    await until(()=>db.prepare("SELECT COUNT(*) n FROM ai_jobs WHERE id IN (?,?) AND status='completed'").get(first.id,second.id).n===2);
  });
  it('hides expired history even when bounded physical cleanup has a backlog',async()=>{
    const old=Date.now()-31*86400000;
    db.transaction(()=>{
      for(let i=0;i<201;i++) {
        db.prepare(`INSERT INTO ai_jobs(id,owner_key,feature,status,input_json,idempotency_key,created_at,updated_at)
          VALUES (?,?,'diagnose','failed','{}',?,?,?)`).run(`expired-${i}`,`admin:${actor.id}`,`expired-key-${i}`,old,old);
        db.prepare(`INSERT INTO ai_usage(id,owner_key,connection_id,feature,status,created_at)
          VALUES (?,?,?,'diagnose','completed',?)`).run(`expired-usage-${i}`,`admin:${actor.id}`,connection.id,old);
      }
    })();
    expect(jobs.listJobs(actor).some(row=>row.id.startsWith('expired-'))).toBe(false);
    await expect(jobs.getJob(actor,'expired-200')).rejects.toMatchObject({code:'ai_not_found'});
    expect(jobs.getUsage(actor).requests.every(row=>row.created_at>old)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) n FROM ai_usage WHERE created_at=?').get(old).n).toBeLessThan(201);
  });
});
