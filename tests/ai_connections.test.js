import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dns from 'node:dns/promises';
import Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-connections-'));
process.env.DATA_DIR = dataDir;
let db, ai, transport, migrateAiSchema, server, base;
let requests = [], reply;
const admin = { id: 1, is_admin: true }, user = { id: 1, is_admin: false }, other = { id: 2, is_admin: false };
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

beforeAll(async () => {
    ({ default: db } = await import('../src/database/db.js'));
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE admin_users (id INTEGER PRIMARY KEY, is_active INTEGER); CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER, webui_access INTEGER, expiry_date INTEGER); INSERT INTO admin_users VALUES (1,1); INSERT INTO users VALUES (1,1,1,NULL),(2,1,1,NULL);');
    ({ migrateAiSchema } = await import('../src/database/migrationAi.js'));
    migrateAiSchema(db);
    ai = await import('../src/services/ai/connections.js');
    transport = await import('../src/services/ai/transport.js');
    server = http.createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        requests.push({ url: req.url, key: req.headers.authorization, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (reply) return reply(req, res);
        res.end(JSON.stringify(req.method === 'GET' ? { data: [{ id: 'synthetic-model' }] } : { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/proxy/v1`;
});
afterAll(async () => { vi.restoreAllMocks(); if (server) await new Promise(resolve => server.close(resolve)); db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => {
    if (!db || !ai) return;
    for (const table of ['ai_connections','ai_preferences','ai_usage','ai_jobs']) db.exec(`DELETE FROM ${table}`);
    db.exec('DELETE FROM settings; UPDATE users SET is_active=1,webui_access=1');
    requests = []; reply = null;
});
function configure(actor = admin) {
    ai.updateAiSettings(admin, { enabled: true, allow_own_connections: true, allowed_user_ids: [1,2], functions: ['list','search'], internal_targets: [base] });
    const connection = ai.saveConnection(actor, { name: 'Synthetic', base_url: base, api_key: 'synthetic-secret', enabled: true, functions: ['list','search'] });
    ai.savePreferences(actor, { enabled: true, connection_id: connection.id });
    return connection;
}
async function selected(actor = admin) {
    let c = configure(actor);
    await ai.discoverModels(actor, c.id);
    await ai.testModels(actor, c.id, { model_ids: ['synthetic-model'] });
    c = ai.saveConnection(actor, { model_id: 'synthetic-model' }, c.id);
    ai.savePreferences(actor, { model_id: 'synthetic-model' });
    return c;
}

describe('AI connection security', () => {
    it('normalizes known suffixes while retaining proxy prefixes', () => {
        expect(transport.normalizeBaseUrl('https://example.com/proxy/v1/chat/completions/')).toBe('https://example.com/proxy/v1');
        expect(transport.normalizeBaseUrl('https://example.com')).toBe('https://example.com/v1');
        for (const url of ['https://user:key@example.com/v1','https://example.com/v1?key=x','file:///tmp/x','https://example.com/v1#x']) expect(() => transport.normalizeBaseUrl(url)).toThrow();
    });
    it('blocks private, metadata, multicast and mapped addresses unless an exact permitted internal target', async () => {
        for (const host of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','224.0.0.1','[::ffff:127.0.0.1]','[fe90::1]','[fd00:ec2::254]','[2002:7f00:1::]','[2001::1]','[3fff::1]']) {
            await expect(transport.validateTarget(`https://${host}/v1`, [])).rejects.toHaveProperty('code','AI_TARGET_BLOCKED');
        }
        await expect(transport.validateTarget(base, [base])).resolves.toHaveProperty('base_url',base);
        await expect(transport.validateTarget(base + '/other', [base])).rejects.toHaveProperty('code','AI_TARGET_BLOCKED');
        await expect(transport.validateTarget('http://169.254.169.254/v1', ['http://169.254.169.254/v1'])).rejects.toThrow();
    });
    it('rejects mixed public/private DNS and pins all subsequent lookups', async () => {
        const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([{ address:'8.8.8.8',family:4 },{ address:'127.0.0.1',family:4 }]);
        await expect(transport.validateTarget('https://synthetic.example/v1', [])).rejects.toThrow();
        lookup.mockResolvedValueOnce([{address:'8.8.8.8',family:4}]);
        const target = await transport.validateTarget('https://synthetic.example/v1', []);
        const result = await new Promise((resolve,reject) => target.lookup('synthetic.example',{},(err,address) => err ? reject(err) : resolve(address)));
        expect(result).toBe('8.8.8.8'); expect(lookup).toHaveBeenCalledTimes(2); lookup.mockRestore();
    });
    it('migrates idempotently without disturbing records', () => {
        const c = configure(); migrateAiSchema(db); expect(ai.listConnections(admin)[0].id).toBe(c.id);
        expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'").get().n).toBe(10);
    });
    it('keeps admin and normal-user IDs separate and never serializes keys', () => {
        const c = configure(); expect(ai.listConnections(user)).toEqual([]);
        expect(() => ai.deleteConnection(user,c.id)).toThrow();
        const encoded = db.prepare('SELECT data_json FROM ai_connections').get().data_json;
        expect(encoded).not.toContain('synthetic-secret');
        expect(JSON.stringify(c)).not.toContain('encrypted'); expect(c.has_key).toBe(true);
    });
    it('does not call any endpoint while disabled', async () => {
        const c = configure(); ai.updateAiSettings(admin,{enabled:false});
        await expect(ai.discoverModels(admin,c.id)).rejects.toHaveProperty('code','AI_DISABLED');
        await expect(ai.testModels(admin,c.id,{model_ids:['synthetic-model']})).rejects.toThrow();
        await expect(ai.runInference(admin,'list',{connectionId:c.id,messages:[],schema})).rejects.toThrow(); expect(requests).toHaveLength(0);
    });
    it('separates discovery from synthetic tests, bounds tests, persists explicit selection', async () => {
        const c = configure(); const found = await ai.discoverModels(admin,c.id);
        expect(found.models.map(m => m.id)).toEqual(['synthetic-model']); expect(requests).toHaveLength(1); expect(requests[0].body).toBeNull();
        await expect(ai.testModels(admin,c.id,{model_ids:['a','b','c','d']})).rejects.toThrow(); expect(requests).toHaveLength(1);
        const tested = await ai.testModels(admin,c.id,{model_ids:['synthetic-model']}); expect(requests).toHaveLength(3);
        expect(tested.recommended_model_id).toBe('synthetic-model');
        expect(ai.listConnections(admin)[0].model_id).toBeNull();
        ai.saveConnection(admin,{model_id:'synthetic-model'},c.id);
        expect(ai.listConnections(admin)[0].model_id).toBe('synthetic-model');
        expect(requests.slice(1).every(r => r.body.max_tokens > 0 && !JSON.stringify(r.body).includes('IPTV'))).toBe(true);
    });
    it('invalidates discovered capabilities on key and endpoint changes', async () => {
        const c = await selected(); const changed = ai.saveConnection(admin,{api_key:'replacement'},c.id);
        expect(changed.models).toEqual([]); expect(changed.capabilities).toEqual({}); expect(changed.model_id).toBeNull(); expect(changed.version).toBeGreaterThan(c.version);
        await expect(ai.runInference(admin,'list',{messages:[{role:'user',content:'synthetic'}],schema})).rejects.toHaveProperty('code','AI_MODEL_REQUIRED');
    });
    it('advances the connection version for every accepted concurrent worker update', async () => {
        const connection=configure(), gate=new SharedArrayBuffer(4);
        const source=`
            import { parentPort, workerData } from 'node:worker_threads';
            const {default:db}=await import(workerData.database);
            const {saveConnection}=await import(workerData.connections);
            const transaction=db.transaction.bind(db), barrier=new Int32Array(workerData.gate);
            let waiting=true;
            db.transaction=fn=>{
                const write=transaction(fn);
                if(waiting) {
                    waiting=false;
                    if(Atomics.add(barrier,0,1)===0 && Atomics.wait(barrier,0,1,5000)==='timed-out') throw new Error('Writer barrier timed out');
                    Atomics.notify(barrier,0);
                }
                return write;
            };
            let result;
            try { result={ok:true,value:saveConnection({id:1,is_admin:true},{name:workerData.name,api_key:'synthetic-'+workerData.name},workerData.id)}; }
            catch(error) { result={ok:false,code:error.code}; }
            finally { db.close(); }
            parentPort.postMessage(result);
        `;
        // Rendezvous at the write transaction to reproduce overlapping worker updates.
        const workers=['First','Second'].map(name=>new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{
            env:{...process.env,DATA_DIR:dataDir},workerData:{name,id:connection.id,gate,
                database:new URL('../src/database/db.js',import.meta.url).href,
                connections:new URL('../src/services/ai/connections.js',import.meta.url).href}
        }));
        try {
            const results=await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{
                worker.once('message',resolve); worker.once('error',reject);
                worker.once('exit',code=>{if(code!==0)reject(new Error('Writer exited with code '+code));});
            })));
            expect(results.every(result=>result.ok || result.code==='AI_CONNECTION_CHANGED')).toBe(true);
            const accepted=results.filter(result=>result.ok).map(result=>result.value).sort((a,b)=>a.version-b.version);
            expect(accepted.length).toBeGreaterThan(0);
            const stored=ai.listConnections(admin)[0];
            expect(stored.version).toBe(connection.version+accepted.length);
            expect(stored.name).toBe(accepted.at(-1).name);
        } finally { await Promise.all(workers.map(worker=>worker.terminate())); }
    },10000);
    it.each(['discovery','tests','model unavailability'])('rejects stale worker %s results after another setup write wins', async operation => {
        const connection=await selected(), gate=new SharedArrayBuffer(4), count=requests.length;
        reply=(req,res)=>{
            if(operation==='model unavailability') { res.statusCode=404; res.end('{}'); }
            else res.end(JSON.stringify(req.method==='GET' ? {data:[{id:'stale-model'}]} : {choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
        };
        const source=`
            import { parentPort, workerData } from 'node:worker_threads';
            const {default:db}=await import(workerData.database);
            const ai=await import(workerData.connections);
            const prepare=db.prepare.bind(db), barrier=new Int32Array(workerData.gate);
            db.prepare=sql=>{
                if(sql.startsWith('UPDATE ai_connections SET data_json=')) {
                    parentPort.postMessage({type:'ready'});
                    if(Atomics.wait(barrier,0,0,5000)==='timed-out') throw new Error('Result write barrier timed out');
                }
                return prepare(sql);
            };
            let result;
            try {
                const actor={id:1,is_admin:true};
                if(workerData.operation==='discovery') await ai.discoverModels(actor,workerData.id);
                else if(workerData.operation==='tests') await ai.testModels(actor,workerData.id,{model_ids:['stale-model']});
                else await ai.runInference(actor,'list',{messages:[],schema:workerData.schema});
                result={ok:true};
            } catch(error) { result={ok:false,code:error.code}; }
            finally { db.close(); }
            parentPort.postMessage({type:'result',...result});
        `;
        const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{
            env:{...process.env,DATA_DIR:dataDir},workerData:{operation,id:connection.id,gate,schema,
                database:new URL('../src/database/db.js',import.meta.url).href,
                connections:new URL('../src/services/ai/connections.js',import.meta.url).href}
        });
        const message=type=>new Promise((resolve,reject)=>{
            worker.on('message',value=>{ if(value.type===type) resolve(value); else if(value.type==='result' && type==='ready') reject(new Error('Worker did not reach the write barrier: '+JSON.stringify(value))); });
            worker.once('error',reject);
            worker.once('exit',code=>{if(code!==0) reject(new Error('Writer exited with code '+code));});
        });
        const ready=message('ready'), result=message('result');
        try {
            // The worker holds a result snapshot, but no longer owns a usage reservation.
            await ready;
            expect(db.prepare("SELECT count(*) AS n FROM ai_usage WHERE status='running'").get().n).toBe(0);
            reply=null;
            if(operation==='discovery') await ai.discoverModels(admin,connection.id);
            else await ai.testModels(admin,connection.id,{model_ids:[operation==='tests'?'winner-model':'synthetic-model']});
            const winner=ai.listConnections(admin)[0], preferences=ai.getPreferences(admin);
            Atomics.store(new Int32Array(gate),0,1); Atomics.notify(new Int32Array(gate),0);
            expect(await result).toMatchObject({ok:false,code:'AI_CONNECTION_CHANGED'});
            expect(ai.listConnections(admin)[0]).toEqual(winner);
            expect(winner.version).toBe(connection.version+1);
            expect(ai.getPreferences(admin)).toEqual(preferences);
            expect(preferences.model_id).toBe('synthetic-model');
            expect(requests).toHaveLength(count+({discovery:2,tests:4,'model unavailability':3}[operation]));
        } finally { await worker.terminate(); }
    },10000);
    it('does not follow redirects or expose provider error bodies', async () => {
        const c = configure(); reply = (_req,res) => {res.statusCode=302;res.setHeader('location','https://example.com/stolen');res.end('synthetic-secret');};
        await expect(ai.discoverModels(admin,c.id)).rejects.toMatchObject({code:'AI_REDIRECT_BLOCKED'}); expect(requests).toHaveLength(1);
        reply = (_req,res) => {res.statusCode=401;res.end('synthetic-secret');};
        try {await ai.discoverModels(admin,c.id);} catch(e) {expect(e.code).toBe('AI_AUTH_FAILED');expect(e.message).not.toContain('synthetic-secret');}
    });
    it('reloads user permission immediately before every model call', async () => {
        const c = await selected(user); db.exec('UPDATE users SET webui_access=0 WHERE id=1'); const count=requests.length;
        await expect(ai.runInference(user,'list',{connectionId:c.id,messages:[],schema})).rejects.toHaveProperty('code','AI_FORBIDDEN'); expect(requests).toHaveLength(count);
    });
    it('validates fallback JSON and rejects truncated, oversized and unknown-key results', async () => {
        await selected();
        const out = await ai.runInference(admin,'list',{messages:[{role:'user',content:'synthetic'}],schema}); expect(out.data).toEqual({ok:true}); expect(out.usage.prompt_tokens).toBe(4);
        for (const content of ['{"ok":true,"secret":"x"}','{"ok":"true"}','not JSON']) {
            reply=(_req,res)=>res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
            await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toThrow();
        }
    });
    it('reserves usage across connections and fails before sending when active capacity is exhausted', async () => {
        const c = await selected(); db.prepare('INSERT INTO ai_usage(id,owner_key,connection_id,feature,status,created_at) VALUES(?,?,?,?,?,?)').run('busy','admin:1',c.id,'list','running',Date.now());
        const count=requests.length; await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_BUSY'); expect(requests).toHaveLength(count);
    });
    it.each(['discovery','compatibility tests'])('prunes expired usage during setup-only %s without changing current reservations', async operation => {
        const c=configure(), now=Date.now(), cutoff=now-30*86400000;
        const clock=vi.spyOn(Date,'now').mockReturnValue(now);
        try {
            const insert=db.prepare('INSERT INTO ai_usage(id,owner_key,connection_id,feature,status,created_at) VALUES(?,?,?,?,?,?)');
            for(let i=0;i<201;i++) insert.run(`expired-${i}`,'admin:1',c.id,'setup',['completed','failed','unknown'][i%3],cutoff-1-i);
            insert.run('retention-boundary','admin:1',c.id,'setup','completed',cutoff);
            insert.run('recent','admin:1',c.id,'setup','unknown',now-3600000);
            insert.run('other-active','user:2','other-connection','setup','running',now);
            const controls=db.prepare("SELECT * FROM ai_usage WHERE id NOT LIKE 'expired-%' ORDER BY id").all();
            const run=()=>operation==='discovery' ? ai.discoverModels(admin,c.id) : ai.testModels(admin,c.id,{model_ids:['synthetic-model']});
            await run();
            expect(db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at<?').get(cutoff).n).toBe(operation==='discovery'?101:1);
            for(let i=1;i<(operation==='discovery'?3:2);i++) await run();
            expect(db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at<?').get(cutoff).n).toBe(0);
            expect(db.prepare("SELECT * FROM ai_usage WHERE id IN ('retention-boundary','recent','other-active') ORDER BY id").all()).toEqual(controls);
            expect(requests).toHaveLength(operation==='discovery'?3:4);
        } finally { clock.mockRestore(); }
    });
    it('authorizes shared access without exposing or mutating the owner key', async () => {
        const c = await selected(); ai.saveConnection(admin,{shared:true,allowed_user_ids:[1]},c.id);
        ai.savePreferences(user,{enabled:true,connection_id:c.id});
        expect(ai.listConnections(user)[0].has_key).toBe(true); expect(ai.listConnections(other)).toEqual([]);
        await expect(ai.testModels(user,c.id,{model_ids:['synthetic-model']})).rejects.toHaveProperty('code','AI_FORBIDDEN');
        await expect(ai.runInference(user,'list',{messages:[],schema})).resolves.toHaveProperty('data.ok',true);
    });
    it('reports edit rights and keeps optional auto sync summary off', async () => {
        const c=await selected(); ai.saveConnection(admin,{shared:true,allowed_user_ids:[1]},c.id);
        expect(ai.listConnections(admin)[0].editable).toBe(true); expect(ai.listConnections(user)[0].editable).toBe(false);
        expect(ai.getPreferences(user).auto_sync_summary).toBe(false);
        expect(ai.savePreferences(user,{auto_sync_summary:true}).auto_sync_summary).toBe(true);
        expect(ai.isAiEnabled()).toBe(true); ai.updateAiSettings(admin,{enabled:false}); expect(ai.isAiEnabled()).toBe(false);
    });
    it('rejects truncated and oversized responses without silently retrying', async () => {
        await selected();
        reply=(_req,res)=>res.end(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"ok":true}'}}]}));
        let count=requests.length;
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_INVALID_RESPONSE'); expect(requests).toHaveLength(count+1);
        reply=(_req,res)=>res.end(JSON.stringify({padding:'x'.repeat(600000)})); count=requests.length;
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_RESPONSE_TOO_LARGE'); expect(requests).toHaveLength(count+1);
    });
    it('keeps missing usage unknown and permits only explicit bounded token profiles', async () => {
        let c=configure(); c=ai.saveConnection(admin,{token_parameter:'max_completion_tokens'},c.id);
        await ai.testModels(admin,c.id,{model_ids:['synthetic-model']});
        expect(requests.every(r=>r.body.max_completion_tokens===128 && !r.body.max_tokens)).toBe(true);
        ai.saveConnection(admin,{model_id:'synthetic-model'},c.id);
        reply=(_req,res)=>res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
        const result=await ai.runInference(admin,'list',{messages:[],schema}); expect(result.usage).toEqual({prompt_tokens:null,completion_tokens:null});
        expect(requests.at(-1).body.max_completion_tokens).toBe(2048);
    });
    it('blocks shared calls when the owning administrator has been disabled', async () => {
        const c=await selected(); ai.saveConnection(admin,{shared:true,allowed_user_ids:[1]},c.id); ai.savePreferences(user,{enabled:true,connection_id:c.id});
        db.exec('UPDATE admin_users SET is_active=0 WHERE id=1');
        try { await expect(ai.runInference(user,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_FORBIDDEN'); }
        finally { db.exec('UPDATE admin_users SET is_active=1'); }
    });
    it('requires HTTPS for public addresses even if listed as an internal exception', async () => {
        await expect(transport.validateTarget('http://8.8.8.8/v1',['http://8.8.8.8/v1'])).rejects.toHaveProperty('code','AI_TARGET_BLOCKED');
        expect(()=>transport.normalizeBaseUrl('https:example.com')).toThrow();
    });
    it('retains tested JSON fallback when strict schema mode is rejected', async () => {
        const c=configure();
        reply=(req,res)=>{ if (requests.at(-1).body.response_format) {res.statusCode=400;res.end('{}');} else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})); };
        const result=await ai.testModels(admin,c.id,{model_ids:['unknown-alias']}); expect(result.models[0]).toMatchObject({chat:true,structured:false,status:'json_fallback'});
        ai.saveConnection(admin,{model_id:'unknown-alias'},c.id);
        await expect(ai.runInference(admin,'list',{messages:[],schema})).resolves.toHaveProperty('data.ok',true); expect(requests.at(-1).body.response_format).toBeUndefined();
    });
    it('aborts rejected credentials without classifying them as connection outages', async () => {
        const c=configure(); reply=(_req,res)=>{res.statusCode=401;res.end('{}');};
        for(let i=0;i<3;i++) await expect(ai.testModels(admin,c.id,{model_ids:['a','b','c']})).rejects.toHaveProperty('code','AI_AUTH_FAILED');
        expect(requests).toHaveLength(3);
        await expect(ai.discoverModels(admin,c.id)).rejects.toHaveProperty('code','AI_AUTH_FAILED'); expect(requests).toHaveLength(4);
    });
    it('keeps a fourth chat candidate testable after three non-chat endpoint rejections', async () => {
        const c=configure();
        reply=(_req,res)=>{ res.statusCode=404; res.end(JSON.stringify({error:{message:'This is not a chat model and thus not supported in the v1/chat/completions endpoint.',type:'invalid_request_error',param:'model',code:null}})); };
        const rejected=await ai.testModels(admin,c.id,{model_ids:['embedding-one','image-two','audio-three']});
        expect(rejected.models.every(model=>!model.chat && model.status==='incompatible' && model.error_code==='AI_CAPABILITY_UNSUPPORTED')).toBe(true);
        expect(db.prepare('SELECT error_code FROM ai_usage').all()).toEqual(Array.from({length:3},()=>({error_code:'AI_CAPABILITY_UNSUPPORTED'})));
        reply=null;
        const tested=await ai.testModels(admin,c.id,{model_ids:['unknown-alias']});
        expect(tested.recommended_model_id).toBe('unknown-alias'); expect(requests).toHaveLength(5);
        expect(requests.every(request=>request.key==='Bearer synthetic-secret' && request.url==='/proxy/v1/chat/completions')).toBe(true);
    });
    it('classifies schema rejection separately and retains the tested plain JSON capability', async () => {
        const c=configure();
        reply=(_req,res)=>{
            if (requests.at(-1).body.response_format) { res.statusCode=400; res.end(JSON.stringify({error:{code:'unsupported_value',param:'response_format',message:"'json_schema' is not supported with this model."}})); }
            else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
        };
        const result=await ai.testModels(admin,c.id,{model_ids:['unknown-alias']});
        expect(result.models[0]).toMatchObject({chat:true,structured:false,status:'json_fallback',error_code:'AI_CAPABILITY_UNSUPPORTED'});
        expect(db.prepare("SELECT error_code FROM ai_usage WHERE status='failed'").get().error_code).toBe('AI_CAPABILITY_UNSUPPORTED');
        ai.saveConnection(admin,{model_id:'unknown-alias'},c.id);
        await expect(ai.runInference(admin,'list',{messages:[],schema})).resolves.toHaveProperty('data.ok',true);
        expect(requests.at(-1).body.response_format).toBeUndefined();
    });
    it.each([[403,'AI_PERMISSION_DENIED'],[429,'AI_RATE_LIMIT'],[503,'AI_UNAVAILABLE']])('stops the candidate batch on HTTP %s without changing identity or provider', async (status,code) => {
        const c=configure(); reply=(_req,res)=>{res.statusCode=status;res.end(JSON.stringify({error:{message:'synthetic-secret',code:'unsupported_parameter',param:'max_tokens'}}));};
        await expect(ai.testModels(admin,c.id,{model_ids:['a','b','c']})).rejects.toHaveProperty('code',code);
        expect(requests).toHaveLength(1); expect(requests[0].body.max_tokens).toBe(128);
        expect(ai.listConnections(admin)[0]).toMatchObject({model_id:null,token_parameter:'max_tokens'});
        expect(JSON.stringify(db.prepare('SELECT * FROM ai_usage').all())).not.toContain('synthetic-secret');
    });
    it('retains the circuit breaker for three actual server failures', async () => {
        const c=configure(); reply=(_req,res)=>{res.statusCode=503;res.end('{}');};
        for(let i=0;i<3;i++) await expect(ai.testModels(admin,c.id,{model_ids:['a']})).rejects.toHaveProperty('code','AI_UNAVAILABLE');
        await expect(ai.testModels(admin,c.id,{model_ids:['working']})).rejects.toHaveProperty('code','AI_PAUSED');
        expect(requests).toHaveLength(3);
    });
    it.each(['max_tokens','max_completion_tokens'])('probes the alternate token profile once after explicit rejection of %s', async rejected => {
        const alternate=rejected==='max_tokens'?'max_completion_tokens':'max_tokens';
        let c=configure(); c=ai.saveConnection(admin,{token_parameter:rejected},c.id);
        reply=(_req,res)=>{
            if (Object.hasOwn(requests.at(-1).body,rejected)) {
                res.statusCode=400; res.end(JSON.stringify({error:{message:`Unsupported parameter: '${rejected}' is not supported with this model. Use '${alternate}' instead.`,type:'invalid_request_error',param:rejected,code:'unsupported_parameter'}}));
            } else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
        };
        const result=await ai.testModels(admin,c.id,{model_ids:['unknown-alias']});
        expect(result.models[0]).toMatchObject({chat:true,structured:true,token_parameter:alternate,status:'compatible'});
        expect(requests).toHaveLength(3); expect(requests.slice(1).every(request=>request.body[alternate]===128 && !Object.hasOwn(request.body,rejected))).toBe(true);
        expect(ai.listConnections(admin)[0].token_parameter).toBe(rejected);
        expect(()=>ai.savePreferences(admin,{model_id:'unknown-alias'})).toThrow(expect.objectContaining({code:'AI_MODEL_REQUIRED'}));
        // Explicit adoption is the only operation that changes the connection profile.
        c=ai.saveConnection(admin,{model_id:'unknown-alias',token_parameter:alternate},c.id);
        expect(c).toMatchObject({model_id:'unknown-alias',token_parameter:alternate});
        ai.savePreferences(admin,{model_id:'unknown-alias'});
        await expect(ai.runInference(admin,'list',{messages:[],schema})).resolves.toHaveProperty('data.ok',true);
        expect(requests.at(-1).body[alternate]).toBe(2048);
    });
    it('does not loop when both token profiles are explicitly rejected', async () => {
        const c=configure(); reply=(_req,res)=>{res.statusCode=400;res.end(JSON.stringify({error:{code:'unsupported_parameter',param:requests.at(-1).body.max_tokens?'max_tokens':'max_completion_tokens'}}));};
        const result=await ai.testModels(admin,c.id,{model_ids:['alias']});
        expect(requests).toHaveLength(2); expect(result.models[0]).toMatchObject({chat:false,error_code:'AI_TOKEN_PARAMETER_UNSUPPORTED'});
    });
    it('does not change token parameters when only the supplied value is rejected', async () => {
        const c=configure(); reply=(_req,res)=>{res.statusCode=400;res.end(JSON.stringify({error:{code:'unsupported_value',param:'max_tokens',message:'Unsupported value: max_tokens must be at least 256.'}}));};
        const result=await ai.testModels(admin,c.id,{model_ids:['alias']});
        expect(requests).toHaveLength(1); expect(result.models[0]).toMatchObject({chat:false,status:'unverified',token_parameter:'max_tokens'});
    });
    it.each(['malformed','truncated','ambiguous rejection'])('does not retry or claim incompatibility after %s output', async kind => {
        const c=configure(); reply=(_req,res)=>{
            if(kind==='ambiguous rejection') {res.statusCode=400;res.end(JSON.stringify({error:{message:'Invalid request'}}));}
            else res.end(JSON.stringify({choices:[{finish_reason:kind==='truncated'?'length':'stop',message:{content:'not JSON'}}]}));
        };
        const result=await ai.testModels(admin,c.id,{model_ids:['alias']});
        expect(requests).toHaveLength(1); expect(result.models[0]).toMatchObject({chat:false,status:'unverified',error_code:'AI_INVALID_RESPONSE'});
    });
    it('does not retry an uncertain model-test timeout with another profile or candidate', async () => {
        const c=configure(); reply=()=>{};
        const nativeTimeout=globalThis.setTimeout;
        const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation((callback,ms,...args)=>nativeTimeout(callback,ms===30000?20:ms,...args));
        try {
            await expect(ai.testModels(admin,c.id,{model_ids:['alias','other']})).rejects.toHaveProperty('code','AI_TIMEOUT');
            expect(requests).toHaveLength(1);
            expect(db.prepare('SELECT status,prompt_tokens,completion_tokens FROM ai_usage').get()).toEqual({status:'unknown',prompt_tokens:null,completion_tokens:null});
        } finally { timer.mockRestore(); }
    });
    it('requires explicit adoption when an in-use model needs a different token profile', async () => {
        const c=await selected(); const before=requests.length;
        reply=(_req,res)=>{
            if(requests.at(-1).body.max_tokens) {res.statusCode=400;res.end(JSON.stringify({error:{code:'unsupported_parameter',param:'max_tokens'}}));}
            else res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
        };
        await ai.testModels(admin,c.id,{model_ids:['synthetic-model']});
        expect(ai.listConnections(admin)[0]).toMatchObject({model_id:'synthetic-model',token_parameter:'max_tokens'});
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_MODEL_REQUIRED');
        expect(requests.length-before).toBe(3);
    });
    it('keeps selection on discovery refresh or removal and only retains bounded candidate hints', async () => {
        const c=await selected();
        reply=(_req,res)=>res.end(JSON.stringify({data:[
            {id:'image-first',architecture:{input_modalities:['text'],output_modalities:['image']},description:'synthetic-secret'},
            {id:'unknown-alias',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['max_tokens','response_format']},
            {id:'gpt-chat-name-alone'}, {id:'alias-with-bad-metadata',architecture:{input_modalities:'text',output_modalities:'text'}}
        ]}));
        const found=await ai.discoverModels(admin,c.id);
        expect(found.models).toEqual([{id:'image-first',candidate:'other'},{id:'unknown-alias',candidate:'text'},{id:'gpt-chat-name-alone',candidate:'unknown'},{id:'alias-with-bad-metadata',candidate:'unknown'}]);
        expect(found.model_id).toBe('synthetic-model'); expect(ai.getPreferences(admin).model_id).toBe('synthetic-model');
        expect(JSON.stringify(found)).not.toContain('synthetic-secret');
    });
    it('bounds repeated manual model tests while retaining both selected profiles', async () => {
        const c=await selected();
        await ai.testModels(admin,c.id,{model_ids:['personal-model']});
        ai.savePreferences(admin,{model_id:'personal-model'});
        const start=Date.now(); let now=start;
        const date=vi.spyOn(Date,'now').mockImplementation(()=>now);
        try {
            // Each batch runs in a later quota window; all requests use the local fixture.
            for(let batch=0;batch<35;batch++) {
                now=start+(batch+1)*3600000;
                await ai.testModels(admin,c.id,{model_ids:[0,1,2].map(index=>`history-${batch*3+index}`)});
            }
            const stored=JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json);
            expect(Object.keys(stored.capabilities)).toHaveLength(100);
            for(const model of ['synthetic-model','personal-model','history-102','history-103','history-104']) expect(stored.capabilities[model]?.chat).toBe(true);
            expect(stored.capabilities['history-0']).toBeUndefined();
            expect(ai.requireAiAccess(admin,'list').preferences.model_id).toBe('personal-model');
            expect(ai.listConnections(admin)[0].model_id).toBe('synthetic-model');
        } finally {date.mockRestore();}
    });
    it('bounds legacy profile responses without read-side writes and trims the row on refresh', async () => {
        const c=await selected();
        const row=db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id),data=JSON.parse(row.data_json);
        for(let i=0;i<150;i++) data.capabilities[`legacy-${i}`]={id:`legacy-${i}`,chat:true,structured:false,token_parameter:'max_tokens',tested_at:Date.now()+i+1};
        const oversized=JSON.stringify(data);
        db.prepare('UPDATE ai_connections SET data_json=? WHERE id=?').run(oversized,c.id);
        const visible=ai.listConnections(admin)[0];
        expect(Object.keys(visible.capabilities)).toHaveLength(100);
        expect(visible.capabilities['synthetic-model'].chat).toBe(true);
        expect(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json).toBe(oversized);
        await ai.discoverModels(admin,c.id);
        const stored=JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json);
        expect(Object.keys(stored.capabilities)).toHaveLength(100);
        expect(stored.model_id).toBe('synthetic-model');
    });
    it('keeps the just-tested batch usable when older profile timestamps are ahead of the clock', async () => {
        const c=await selected();
        const data=JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json);
        for(let i=0;i<99;i++) data.capabilities[`future-${i}`]={id:`future-${i}`,chat:true,token_parameter:'max_tokens',tested_at:Date.now()+3600000+i};
        db.prepare('UPDATE ai_connections SET data_json=? WHERE id=?').run(JSON.stringify(data),c.id);
        const tested=await ai.testModels(admin,c.id,{model_ids:['new-a','new-b','new-c']});
        const profiles=ai.listConnections(admin)[0].capabilities;
        expect(Object.keys(profiles)).toHaveLength(100);
        for(const model of tested.models) expect(profiles[model.id]?.chat).toBe(true);
        expect(profiles['synthetic-model'].chat).toBe(true);
        expect(()=>ai.savePreferences(admin,{model_id:tested.recommended_model_id})).not.toThrow();
    });
    it.each([
        ['existing IDs',['cached-96','cached-97','cached-98'],[]],
        ['mixed existing and new IDs',['cached-0','cached-98','new-model'],['cached-1']]
    ])('reserves only added profile capacity when retesting %s', async (_label,modelIds,evicted) => {
        const c=await selected();
        const data=JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json);
        for(let i=0;i<99;i++) data.capabilities[`cached-${i}`]={id:`cached-${i}`,chat:true,structured:false,token_parameter:'max_tokens',tested_at:Date.now()+3600000+i};
        db.prepare('UPDATE ai_connections SET data_json=? WHERE id=?').run(JSON.stringify(data),c.id);
        ai.savePreferences(admin,{model_id:'cached-98'});
        const expected=[...new Set([...Object.keys(data.capabilities).filter(id=>!evicted.includes(id)),...modelIds])].sort();
        const count=requests.length;
        await ai.testModels(admin,c.id,{model_ids:modelIds});
        const stored=JSON.parse(db.prepare('SELECT data_json FROM ai_connections WHERE id=?').get(c.id).data_json);
        expect(Object.keys(stored.capabilities).sort()).toEqual(expected);
        for(const id of modelIds) expect(stored.capabilities[id]).toMatchObject({chat:true,structured:true,status:'compatible'});
        expect(ai.requireAiAccess(admin,'list').preferences.model_id).toBe('cached-98');
        expect(stored.model_id).toBe('synthetic-model');
        expect(requests).toHaveLength(count+6);
    });
    it('rejects already-cancelled requests before network activity', async () => {
        await selected(); const count=requests.length;
        await expect(ai.runInference(admin,'list',{messages:[],schema,signal:AbortSignal.abort()})).rejects.toHaveProperty('code','AI_TIMEOUT'); expect(requests).toHaveLength(count);
    });
    it('keeps local feature and owner hourly limits independent', async () => {
        const c=await selected(); const insert=db.prepare("INSERT INTO ai_usage(id,owner_key,connection_id,feature,status,created_at) VALUES(?,?,?,?,'completed',?)");
        for(let i=0;i<30;i++) insert.run(`limit-${i}`,'admin:1',c.id,'list',Date.now());
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_RATE_LIMIT');
        await expect(ai.runInference(admin,'search',{messages:[],schema})).resolves.toHaveProperty('data.ok',true);
    });
    it('rechecks policy after DNS and drops a response if the connection changes in flight', async () => {
        const c=await selected();
        reply=(_req,res)=>{ ai.saveConnection(admin,{name:'Changed'},c.id); res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})); };
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_CONNECTION_CHANGED');
        reply=null;
        const lookup=vi.spyOn(dns,'lookup').mockImplementation(async()=>{ai.updateAiSettings(admin,{enabled:false});return [{address:'8.8.8.8',family:4}];});
        const changed=ai.saveConnection(admin,{base_url:'https://synthetic.example/v1'},c.id); const count=requests.length;
        await expect(ai.discoverModels(admin,changed.id)).rejects.toHaveProperty('code','AI_DISABLED'); expect(requests).toHaveLength(count); lookup.mockRestore();
    });
    it('records provider token usage even when its JSON answer is rejected', async () => {
        await selected();
        reply=(_req,res)=>res.end(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"ok":true}'}}],usage:{prompt_tokens:25,completion_tokens:128}}));
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toThrow();
        expect(db.prepare("SELECT prompt_tokens,completion_tokens FROM ai_usage WHERE feature='list'").get()).toEqual({prompt_tokens:25,completion_tokens:128});
    });
    it('requires a fresh model test after the selected model is removed', async () => {
        const connection=await selected(); reply=(_req,res)=>{res.statusCode=404;res.end('{}');};
        await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_MODEL_UNAVAILABLE');
        expect(ai.listConnections(admin)[0]).toMatchObject({version:connection.version+1,model_id:null,capabilities:{'synthetic-model':{chat:false,status:'unavailable'}}});
        expect(ai.getPreferences(admin).model_id).toBeNull();
        const count=requests.length; await expect(ai.runInference(admin,'list',{messages:[],schema})).rejects.toHaveProperty('code','AI_MODEL_REQUIRED'); expect(requests).toHaveLength(count);
        reply=null; await ai.testModels(admin,ai.getPreferences(admin).connection_id,{model_ids:['synthetic-model']});
        expect(()=>ai.requireAiAccess(admin,'list')).toThrow(expect.objectContaining({code:'AI_MODEL_REQUIRED'}));
    });
    it.each(['key','endpoint','profile'])('requires renewed selection after %s invalidation and retesting', async kind => {
        const c=await selected(); const change={key:{api_key:'replacement'},endpoint:{base_url:base+'/new'},profile:{token_parameter:'max_completion_tokens'}}[kind];
        if(kind==='endpoint') ai.updateAiSettings(admin,{internal_targets:[base,base+'/new']});
        ai.saveConnection(admin,change,c.id);
        expect(ai.getPreferences(admin).model_id).toBeNull();
        await ai.testModels(admin,c.id,{model_ids:['synthetic-model']});
        expect(()=>ai.requireAiAccess(admin,'list')).toThrow(expect.objectContaining({code:'AI_MODEL_REQUIRED'}));
        ai.savePreferences(admin,{model_id:'synthetic-model'});
        expect(ai.requireAiAccess(admin,'list').preferences.model_id).toBe('synthetic-model');
    });
    it('pauses three serialized timeouts while retaining unknown usage', async () => {
        const c=configure(); reply=()=>{};
        const nativeTimeout=globalThis.setTimeout;
        const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation((callback,ms,...args)=>nativeTimeout(callback,ms===30000?20:ms,...args));
        const now=Date.now(); let clock=now;
        const date=vi.spyOn(Date,'now').mockImplementation(()=>clock);
        try {
            for(let i=0;i<3;i++) {
                await expect(ai.discoverModels(admin,c.id)).rejects.toHaveProperty('code','AI_TIMEOUT');
                clock+=31000;
            }
            expect(db.prepare('SELECT status,prompt_tokens,completion_tokens FROM ai_usage').all()).toEqual(Array.from({length:3},()=>({status:'unknown',prompt_tokens:null,completion_tokens:null})));
            await expect(ai.discoverModels(admin,c.id)).rejects.toHaveProperty('code','AI_PAUSED'); expect(requests).toHaveLength(3);
        } finally {timer.mockRestore();date.mockRestore();}
    });
    it('does not treat explicit user cancellation as a provider outage', async () => {
        const c=await selected(), count=requests.length;
        for(let i=0;i<3;i++) await expect(ai.runInference(admin,'list',{messages:[],schema,signal:AbortSignal.abort()})).rejects.toHaveProperty('code','AI_TIMEOUT');
        expect(db.prepare("SELECT status,error_code FROM ai_usage WHERE feature='list'").all()).toEqual(Array.from({length:3},()=>({status:'unknown',error_code:'AI_CANCELLED'})));
        await expect(ai.discoverModels(admin,c.id)).resolves.toHaveProperty('id',c.id); expect(requests).toHaveLength(count+1);
    });
    it('does not reuse another connection preference to bypass renewed selection', async () => {
        const first=await selected();
        const second=configure(); await ai.testModels(admin,second.id,{model_ids:['synthetic-model']});
        ai.savePreferences(admin,{connection_id:first.id,model_id:'synthetic-model'});
        expect(()=>ai.requireAiAccess(admin,'list',second.id)).toThrow(expect.objectContaining({code:'AI_MODEL_REQUIRED'}));
    });
    it.each(['users','admin_users'])('deleting %s cleans AI keys and private records without crossing owner namespaces', table => {
        const fixture=new Database(':memory:');
        fixture.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE admin_users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2); INSERT INTO admin_users VALUES(1),(2);');
        migrateAiSchema(fixture); migrateAiSchema(fixture);
        const targetTables=['ai_jobs','ai_proposals','ai_changes','ai_conversations','ai_rules','ai_enrichments'];
        const ownerTables=['ai_connections','ai_preferences','ai_usage',...targetTables];
        const samples=[{owner:'user:1',user:2},{owner:'admin:1',user:1},{owner:'admin:2',user:2},{owner:'user:2',user:1}];
        for(const name of ownerTables) {
            const columns=fixture.prepare(`PRAGMA table_info(${name})`).all().filter(c=>c.notnull && c.dflt_value===null || c.pk || c.name==='user_id').map(c=>c.name);
            samples.forEach((sample,index)=>{
                const values={id:`${name}-${index}`,owner_key:sample.owner,user_id:sample.user,data_json:'{}',input_json:'{}',connection_id:'connection',feature:'list',status:'completed',idempotency_key:`key-${index}`,created_at:1,updated_at:1,provider_channel_id:1,source_hash:'hash',language:'en',model:'fixture',prompt_version:'v1'};
                fixture.prepare(`INSERT INTO ${name}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(column=>values[column]));
            });
        }
        fixture.exec("INSERT INTO ai_sync_snapshots VALUES('one',1,1,'{}',1),('two',2,1,'{}',1)");
        fixture.prepare(`DELETE FROM ${table} WHERE id=1`).run();
        for(const name of ownerTables) {
            const remaining=fixture.prepare(`SELECT owner_key${targetTables.includes(name)?',user_id':''} FROM ${name} ORDER BY owner_key`).all();
            const expected=samples.filter(sample=>sample.owner!==(table==='users'?'user:1':'admin:1') && !(table==='users' && targetTables.includes(name) && sample.user===1)).map(sample=>targetTables.includes(name)?{owner_key:sample.owner,user_id:sample.user}:{owner_key:sample.owner}).sort((a,b)=>a.owner_key.localeCompare(b.owner_key));
            expect(remaining,name).toEqual(expected);
        }
        expect(fixture.prepare('SELECT user_id FROM ai_sync_snapshots ORDER BY user_id').all()).toEqual(table==='users'?[{user_id:2}]:[{user_id:1},{user_id:2}]);
        expect(fixture.prepare(`SELECT count(*) AS n FROM ${table==='users'?'admin_users':'users'} WHERE id=1`).get().n).toBe(1);
        fixture.close();
    });
});
