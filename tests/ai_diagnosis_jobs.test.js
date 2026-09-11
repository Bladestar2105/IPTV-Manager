import { beforeAll,beforeEach,afterAll,describe,it,expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-diagnosis-jobs-'));
process.env.DATA_DIR=dataDir;
const admin={id:991,is_admin:true},user={id:992,is_admin:false};
let db,epg,api,app,connection,server,base,secret,mode='ok',requests=0,pending=[];
const waitFor=async predicate=>{
  const deadline=Date.now()+3000;
  while(!predicate()) {if(Date.now()>deadline)throw new Error('Fixture job did not settle');await new Promise(resolve=>setTimeout(resolve,10));}
};
const release=()=>{for(const send of pending.splice(0))send();};
const bearer=(id=992)=>'Bearer '+jwt.sign({id,is_admin:false,token_version:db.prepare('SELECT token_version FROM users WHERE id=?').get(id).token_version},secret,{algorithm:'HS256'});
const getJob=(id,token=bearer())=>request(app).get('/api/ai/jobs/'+id).set('Authorization',token);
const createJob=(feature='diagnose')=>request(app).post('/api/ai/jobs').set('Authorization',bearer()).send({feature,selected_ids:[997]});
const settled=async id=>{await waitFor(()=>['completed','failed','cancelled'].includes(db.prepare('SELECT status FROM ai_jobs WHERE id=?').get(id).status));return getJob(id);};

beforeAll(async()=>{
  const database=await import('../src/database/db.js');db=database.default;database.initDb(true);
  const epgDatabase=await import('../src/database/epgDb.js');epg=epgDatabase.default;epgDatabase.initEpgDb();
  api=await import('../src/services/ai/connections.js');
  (await import('../src/services/streamManager.js')).default.init(db,null);
  ({JWT_SECRET:secret}=await import('../src/utils/crypto.js'));
  app=express();app.use(express.json());app.use('/api/ai',(await import('../src/routes/ai.js')).default);
  server=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests++;
    if(mode==='auth'){res.writeHead(401);res.end('{}');return;}
    if(mode==='model'){res.writeHead(404);res.end('{"error":{"code":"model_not_found"}}');return;}
    const send=()=>{
      if(res.destroyed)return;
      const setup=body.messages.some(message=>message.content.includes('Synthetic compatibility check'));
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(setup?{ok:true}:{summary:'Fixture explanation'})}}],usage:{prompt_tokens:1,completion_tokens:1}}));
    };
    if(mode==='hold')pending.push(send);else send();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}/v1`;
});
beforeEach(async()=>{
  mode='ok';release();await waitFor(()=>!db.prepare("SELECT 1 FROM ai_jobs WHERE status IN ('queued','running')").get());
  for(const table of ['ai_jobs','ai_usage','ai_preferences','ai_connections','ai_sync_snapshots','current_streams','epg_channel_mappings','user_channels','user_categories','provider_channels','providers','users','admin_users'])db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO admin_users(id,username,password) VALUES(991,'audit-admin','unused');
    INSERT INTO users(id,username,password) VALUES(992,'audit-owner','unused'),(993,'audit-other','unused');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES(994,'Audit provider','https://unused.invalid','unused','unused',992);
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,stream_type) VALUES(995,994,1,'Hidden authorized news','live');
    INSERT INTO user_categories(id,user_id,name) VALUES(996,992,'Audit list');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,is_hidden) VALUES(997,996,995,1);`);
  api.updateAiSettings(admin,{enabled:true,allow_own_connections:false,allowed_user_ids:[992],functions:['diagnose','search'],internal_targets:[base]});
  api.savePreferences(admin,{enabled:true});
  connection=api.saveConnection(admin,{name:'Audit',base_url:base,shared:true,allowed_user_ids:[992]});
  await api.testModels(admin,connection.id,{model_ids:['fixture','replacement']});
  connection=api.saveConnection(admin,{model_id:'fixture'},connection.id);
  api.savePreferences(user,{enabled:true,connection_id:connection.id,model_id:'fixture'});requests=0;
});
afterAll(async()=>{
  mode='ok';release();await waitFor(()=>!db.prepare("SELECT 1 FROM ai_jobs WHERE status IN ('queued','running')").get());
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  epg.close();db.close();fs.rmSync(dataDir,{recursive:true,force:true});
});

describe('local diagnosis through authenticated persisted jobs',()=>{
  it('returns local findings without a selected model and keeps inference strict',async()=>{
    api.saveConnection(admin,{model_id:null},connection.id);
    const create=await createJob();expect(create.status).toBe(200);
    const response=await settled(create.body.id);
    expect(response.status).toBe(200);expect(response.body.status).toBe('completed');
    expect(response.body.result).toMatchObject({explanation_unavailable:true});
    expect(response.body.result.findings.find(item=>item.code==='channel_diagnostics').value).toMatchObject({hidden:true,user_channel_id:997});
    expect(response.body.result).not.toHaveProperty('_authorization');
    expect(requests).toBe(0);
    expect(db.prepare('SELECT request_started_at FROM ai_jobs WHERE id=?').get(create.body.id).request_started_at).toBeNull();
    expect((await createJob('search')).body.code).toBe('AI_MODEL_REQUIRED');
    await expect(api.runInference(user,'diagnose',{connectionId:connection.id,messages:[],schema:{type:'object'}})).rejects.toMatchObject({code:'AI_MODEL_REQUIRED'});
  });
  it('preserves new and previously completed local findings when the selected model disappears upstream',async()=>{
    mode='auth';const previous=await createJob();expect((await settled(previous.body.id)).body.result.explanation_unavailable).toBe(true);
    mode='model';const create=await createJob();const response=await settled(create.body.id);
    expect.soft(response.body.status).toBe('completed');
    expect.soft(response.body.result?.explanation_unavailable).toBe(true);
    const history=await getJob(previous.body.id);
    expect(history.status).toBe(200);expect(history.body.result.explanation_unavailable).toBe(true);
    expect(db.prepare("SELECT error_code FROM ai_usage WHERE feature='diagnose' ORDER BY rowid DESC LIMIT 1").get().error_code).toBe('AI_MODEL_UNAVAILABLE');
  });
  it('revalidates hidden ownership, revocation, source changes, and management tokens on result reads',async()=>{
    mode='auth';const create=await createJob();const result=await settled(create.body.id);expect(result.body.status).toBe('completed');
    expect((await getJob(create.body.id,bearer(993))).status).toBe(404);
    db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=997').run();
    expect((await getJob(create.body.id)).body.code).toBe('AI_SOURCE_UNAVAILABLE');
    db.prepare('UPDATE user_channels SET authorization_revoked=0 WHERE id=997').run();
    db.prepare("UPDATE provider_channels SET name='Changed source' WHERE id=995").run();
    expect((await getJob(create.body.id)).body.code).toBe('AI_STALE_SOURCE');
    const oldToken=bearer();db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=992').run();
    expect((await getJob(create.body.id,oldToken)).status).toBe(401);
  });
  it.each(['policy','connection','grant','user'])('keeps %s permission checks on stored local fallback results',async scope=>{
    mode='auth';const create=await createJob();expect((await settled(create.body.id)).body.status).toBe('completed');
    if(scope==='policy')api.updateAiSettings(admin,{functions:['search']});
    if(scope==='connection')api.saveConnection(admin,{functions:['search']},connection.id);
    if(scope==='grant')api.saveConnection(admin,{allowed_user_ids:[]},connection.id);
    if(scope==='user')db.prepare('UPDATE users SET webui_access=0 WHERE id=992').run();
    expect((await getJob(create.body.id)).status).toBe(403);
  });
  it.each(['version','model','policy','token'])('discards an in-flight result after %s changes',async kind=>{
    if(kind==='model') {
      api.updateAiSettings(admin,{allow_own_connections:true});
      connection=api.saveConnection(user,{name:'Owned fixture',base_url:base});
      await api.testModels(user,connection.id,{model_ids:['fixture','replacement']});
      api.savePreferences(user,{connection_id:connection.id,model_id:'fixture'});
    }
    mode='hold';const create=await createJob();await waitFor(()=>pending.length===1);
    if(kind==='version')api.saveConnection(admin,{name:'Changed configuration'},connection.id);
    if(kind==='model')api.savePreferences(user,{model_id:'replacement'});
    if(kind==='policy')api.updateAiSettings(admin,{functions:['search']});
    if(kind==='token')db.prepare('UPDATE users SET token_version=token_version+1 WHERE id=992').run();
    mode='ok';release();await settled(create.body.id);
    const state=db.prepare('SELECT status,result_json FROM ai_jobs WHERE id=?').get(create.body.id);
    expect(['failed','cancelled']).toContain(state.status);expect(state.result_json).toBeNull();
  });
  it('discards local findings when the owner cancels a running diagnosis',async()=>{
    mode='hold';const create=await createJob();await waitFor(()=>pending.length===1);
    const cancelled=await request(app).post('/api/ai/jobs/'+create.body.id+'/cancel').set('Authorization',bearer()).send({});
    expect(cancelled.body.status).toBe('cancelled');mode='ok';release();
    await waitFor(()=>!db.prepare("SELECT 1 FROM ai_usage WHERE status='running'").get());
    const response=await getJob(create.body.id);
    expect(response.body.status).toBe('cancelled');expect(response.body).not.toHaveProperty('result');
  });
});
