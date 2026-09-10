import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import http from 'node:http';

const dataDir = mkdtempSync(join(tmpdir(), 'iptv-ai-api-'));
process.env.DATA_DIR = dataDir;
let db, app, adminToken, userToken, otherToken, admin, user, other;

beforeAll(async () => {
  const database = await import('../src/database/db.js');
  db = database.default;
  database.initDb(true);
  const { generateToken } = await import('../src/services/authService.js');
  const { encrypt } = await import('../src/utils/crypto.js');
  const insertUser = db.prepare('INSERT INTO users (username,password,is_active,webui_access) VALUES (?,?,1,1)');
  user = { id: Number(insertUser.run('ai-user', encrypt('test-password')).lastInsertRowid), is_admin: false, username: 'ai-user', is_active: 1 };
  other = { id: Number(insertUser.run('ai-other', encrypt('test-password')).lastInsertRowid), is_admin: false, username: 'ai-other', is_active: 1 };
  admin = { id: Number(db.prepare('INSERT INTO admin_users (username,password,is_active) VALUES (?,?,1)').run('ai-admin','unused').lastInsertRowid), is_admin: true, username: 'ai-admin', is_active: 1 };
  [userToken,otherToken,adminToken] = [user,other,admin].map(generateToken);
  ({default:app} = await import('../src/app.js'));
});

afterAll(async () => {
  (await import('../src/database/epgDb.js')).default.close();
  db?.close();
  rmSync(dataDir, {recursive:true,force:true});
});

describe('AI management boundary', () => {
  it('requires a WebUI header bearer even when a valid token is in the query', async () => {
    expect((await request(app).get('/api/ai/settings')).status).toBe(401);
    expect((await request(app).get('/api/ai/settings').query({token: userToken})).status).toBe(401);
  });

  it('starts disabled and forbids normal users from changing server policy', async () => {
    const response = await request(app).get('/api/ai/settings').auth(adminToken,{type:'bearer'});
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
    expect((await request(app).put('/api/ai/settings').auth(userToken,{type:'bearer'}).send({enabled:true})).status).toBe(403);
    expect((await request(app).post('/api/ai/jobs').auth(userToken,{type:'bearer'}).send({feature:'diagnose'})).status).toBe(403);
  });

  it('rejects cross-site mutations even with a valid admin token', async () => {
    const response = await request(app).put('/api/ai/settings').auth(adminToken,{type:'bearer'})
      .set('Origin','https://attacker.invalid').set('Sec-Fetch-Site','cross-site').send({enabled:true});
    expect(response.status).toBe(403);
  });

  it('does not expose another principal history, including an admin with the same numeric ID', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO ai_jobs (id,owner_key,user_id,feature,status,input_json,idempotency_key,created_at,updated_at)
      VALUES ('private-job',?,?,'diagnose','failed','{}','private-key',?,?)`).run(`user:${user.id}`,user.id,now,now);
    expect((await request(app).get('/api/ai/jobs/private-job').auth(userToken,{type:'bearer'})).status).toBe(200);
    for(const token of [otherToken,adminToken]) {
      expect((await request(app).get('/api/ai/jobs/private-job').auth(token,{type:'bearer'})).status).toBe(404);
      expect((await request(app).get('/api/ai/jobs').auth(token,{type:'bearer'})).body).toEqual([]);
    }
  });

  it('sets up a real connection, keeps candidate data private, previews/applies once and undoes through the API', async () => {
    const provider = Number(db.prepare(`INSERT INTO providers (name,url,username,password,user_id)
      VALUES ('My provider','https://private-upstream.invalid','provider-login','provider-key',?)`).run(user.id).lastInsertRowid);
    const channel = Number(db.prepare(`INSERT INTO provider_channels (provider_id,remote_stream_id,name,metadata)
      VALUES (?,1,'DE | News','{"http_headers":{"Authorization":"secret-header"}}')`).run(provider).lastInsertRowid);
    const category = Number(db.prepare("INSERT INTO user_categories (user_id,name) VALUES (?,'My live list')").run(user.id).lastInsertRowid);
    const assignment = Number(db.prepare("INSERT INTO user_channels (user_category_id,provider_channel_id,assignment_origin) VALUES (?,?,'manual')").run(category,channel).lastInsertRowid);
    const sent=[];
    const model = http.createServer(async (req,res) => {
      let raw='';for await(const chunk of req)raw+=chunk;
      const input=JSON.parse(raw);sent.push(input);
      const synthetic=input.messages.at(-1).content.startsWith('Synthetic');
      const data=synthetic?{ok:true}:{summary:'Name normalized',actions:[{type:'rename_channel',user_channel_id:assignment,value:'News'}]};
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:12,completion_tokens:8}}));
    });
    await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
    try {
      const base=`http://127.0.0.1:${model.address().port}/v1`;
      expect((await request(app).put('/api/ai/settings').auth(adminToken,{type:'bearer'}).send({enabled:true,allow_own_connections:true,allowed_user_ids:[user.id],internal_targets:[base]})).status).toBe(200);
      await request(app).put('/api/ai/preferences').auth(userToken,{type:'bearer'}).send({enabled:true,language:'de',timezone:'Europe/Berlin'}).expect(200);
      const created=await request(app).post('/api/ai/connections').auth(userToken,{type:'bearer'}).send({name:'Synthetic model',base_url:base}).expect(200);
      await request(app).post(`/api/ai/connections/${created.body.id}/test`).auth(userToken,{type:'bearer'}).send({model_ids:['fixture']}).expect(200);
      await request(app).put('/api/ai/preferences').auth(userToken,{type:'bearer'}).send({connection_id:created.body.id,model_id:'fixture'}).expect(200);
      const job=await request(app).post('/api/ai/jobs').auth(userToken,{type:'bearer'}).set('Idempotency-Key','api-cleanup-key').send({feature:'cleanup',prompt:'Name bereinigen'}).expect(200);
      let completed;
      for(let i=0;i<100;i++) {
        completed=await request(app).get(`/api/ai/jobs/${job.body.id}`).auth(userToken,{type:'bearer'}).expect(200);
        if(!['queued','running'].includes(completed.body.status))break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(completed.body).toMatchObject({status:'completed',result:{feature:'cleanup'}});
      expect(JSON.stringify(completed.body)).not.toContain('_authorization');
      expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=?').get(assignment).custom_name).toBe('');
      expect(JSON.stringify(sent)).not.toMatch(/private-upstream|provider-login|provider-key|secret-header|http_headers/);
      expect(JSON.parse(sent.at(-1).messages.at(-1).content)).toMatchObject({language:'de',timezone:'Europe/Berlin'});
      const proposal=await request(app).get(`/api/ai/proposals/${completed.body.result.proposal_id}`).auth(userToken,{type:'bearer'}).expect(200);
      const selection={action_ids:proposal.body.actions.map(action=>action.id),idempotency_key:'apply-cleanup-key'};
      const applied=await request(app).post(`/api/ai/proposals/${proposal.body.id}/apply`).auth(userToken,{type:'bearer'}).send(selection).expect(200);
      const repeated=await request(app).post(`/api/ai/proposals/${proposal.body.id}/apply`).auth(userToken,{type:'bearer'}).send(selection).expect(200);
      expect(repeated.body.change_id).toBe(applied.body.change_id);
      expect(db.prepare('SELECT custom_name,assignment_origin FROM user_channels WHERE id=?').get(assignment)).toEqual({custom_name:'News',assignment_origin:'manual'});
      const xtream=await request(app).get('/player_api.php').query({username:'ai-user',password:'test-password',action:'get_live_streams'}).expect(200);
      expect(xtream.body).toEqual(expect.arrayContaining([expect.objectContaining({name:'News'})]));
      const playlist=await request(app).get('/get.php').query({username:'ai-user',password:'test-password',type:'m3u_plus'}).expect(200);
      expect(playlist.text ?? playlist.body.toString('utf8')).toContain('News');
      const mac='02:00:00:00:09:10';
      db.prepare("INSERT INTO stalker_devices(user_id,mac,model,serial_number,device_uid) VALUES (?,?,'MAG254','ai-parity-serial','ai-parity-device')").run(user.id,mac);
      const handshake=await request(app).get('/server/load.php').set('Cookie',`mac=${encodeURIComponent(mac)}`)
        .query({type:'stb',action:'handshake'}).expect(200);
      const stalker=await request(app).get('/server/load.php').auth(handshake.body.js.token,{type:'bearer'})
        .set('Cookie',`mac=${encodeURIComponent(mac)}`).query({type:'itv',action:'get_ordered_list',category:String(category),p:1}).expect(200);
      expect(stalker.body.js.data.map(row=>({id:String(row.id),name:row.name})))
        .toEqual(xtream.body.map(row=>({id:String(row.stream_id),name:row.name})));
      await request(app).post(`/api/ai/changes/${applied.body.change_id}/undo`).auth(userToken,{type:'bearer'}).send({}).expect(200);
      expect(db.prepare('SELECT custom_name,assignment_origin FROM user_channels WHERE id=?').get(assignment)).toEqual({custom_name:'',assignment_origin:'manual'});
    } finally {
      await new Promise(resolve=>model.close(resolve));
    }
  });

  it('offers only actual authorized EPG descriptions and rechecks visibility without model calls', async () => {
    const epgModule=await import('../src/database/epgDb.js');
    epgModule.initEpgDb();
    const epg=epgModule.default;
    const row=db.prepare('SELECT pc.id,pc.provider_id,uc.id AS assignment_id FROM provider_channels pc JOIN user_channels uc ON uc.provider_channel_id=pc.id LIMIT 1').get();
    const foreign=Number(db.prepare("INSERT INTO providers(name,url,username,password,user_id) VALUES ('Foreign EPG','https://foreign.invalid','unused','unused',?)").run(other.id).lastInsertRowid);
    db.prepare("UPDATE provider_channels SET epg_channel_id='ai-program-source' WHERE id=?").run(row.id);
    const now=Math.floor(Date.now()/1000);
    for(const source of [row.provider_id,foreign]) {
      epg.prepare("INSERT INTO epg_channels(id,name,source_type,source_id,updated_at) VALUES('ai-program-source','News','provider',?,?)").run(source,now);
      epg.prepare("INSERT INTO epg_programs(channel_id,source_type,source_id,start,stop,title,desc,lang) VALUES('ai-program-source','provider',?,?,?,?,'Existing description','de')")
        .run(source,now+60,now+3600,source===foreign?'Foreign program':'My documentary');
    }
    const before=db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n;
    const programs=await request(app).get(`/api/ai/channels/${row.id}/programs`).auth(userToken,{type:'bearer'}).expect(200);
    expect(programs.body.items).toEqual([expect.objectContaining({title:'My documentary',description:'Existing description',program:{channel_id:'ai-program-source',source_type:'provider',source_id:row.provider_id,start:now+60}})]);
    expect(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n).toBe(before);
    await request(app).get(`/api/ai/channels/${row.id}/programs`).query({user_id:user.id}).auth(otherToken,{type:'bearer'}).expect(403);
    db.prepare('UPDATE user_channels SET is_hidden=1 WHERE id=?').run(row.assignment_id);
    await request(app).get(`/api/ai/channels/${row.id}/programs`).auth(userToken,{type:'bearer'}).expect(409);
  });

  it('makes rule-applied changes discoverable and undoable only by their owner', async () => {
    const assignment=db.prepare('SELECT id,provider_channel_id FROM user_channels LIMIT 1').get();
    db.prepare("UPDATE user_channels SET is_hidden=0,custom_name='News' WHERE id=?").run(assignment.id);
    const diff={rule_id:'confirmed-rule',feature:'cleanup',diffs:[{table:'user_channels',id:assignment.id,provider_channel_id:assignment.provider_channel_id,before:{custom_name:''},after:{custom_name:'News'}}]};
    db.prepare("INSERT INTO ai_changes(id,owner_key,user_id,data_json,status,created_at) VALUES('rule-history',?,?,?,'applied',?)")
      .run(`user:${user.id}`,user.id,JSON.stringify(diff),Date.now());
    const history=await request(app).get('/api/ai/changes').auth(userToken,{type:'bearer'}).expect(200);
    expect(history.body).toEqual(expect.arrayContaining([expect.objectContaining({id:'rule-history',rule_id:'confirmed-rule',status:'applied'})]));
    expect(history.body.some(row=>row.diffs)).toBe(false);
    expect((await request(app).get('/api/ai/changes').auth(otherToken,{type:'bearer'}).expect(200)).body).toEqual([]);
    await request(app).get('/api/ai/changes/rule-history').auth(otherToken,{type:'bearer'}).expect(404);
    await request(app).post('/api/ai/changes/rule-history/undo').auth(userToken,{type:'bearer'}).send({}).expect(200);
    expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=?').get(assignment.id).custom_name).toBe('');
  });
});
