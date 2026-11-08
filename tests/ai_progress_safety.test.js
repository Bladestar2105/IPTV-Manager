import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['delayed', 'before-acknowledgement', 'completed-in-same-chunk'])('rejects revoked %s progress without crashing the worker', scenario => {
  const protocol = new URL('../src/services/ai/codex/protocol.js', import.meta.url).href;
  const client = new URL('../src/services/ai/codex/client.js', import.meta.url).href;
  const fixture = `
    import { createInterface } from 'node:readline';
    const send = data => process.stdout.write(JSON.stringify(data) + '\\n');
    createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      const result = request.method === 'thread/start'
        ? {thread:{id:'progress-thread'},approvalPolicy:'untrusted',sandbox:{type:'readOnly'}}
        : {turn:{id:'progress-turn'}};
      const event = {method:'turn/started',params:{threadId:'progress-thread'}};
      if (request.method === 'turn/start' && ${JSON.stringify(scenario)} === 'before-acknowledgement') send(event);
      send({id:request.id,result});
      if (request.method === 'turn/start' && ${JSON.stringify(scenario)} === 'delayed') setTimeout(() => send(event), 10);
      if (request.method === 'turn/start' && ${JSON.stringify(scenario)} === 'completed-in-same-chunk') {
        const done = {method:'turn/completed',params:{threadId:'progress-thread',turn:{status:'completed',items:[]}}};
        process.stdout.write(JSON.stringify(event) + '\\n' + JSON.stringify(done) + '\\n');
      }
    });
  `;
  const probe = `
    import { createClient } from ${JSON.stringify(protocol)};
    import { runTurn } from ${JSON.stringify(client)};
    const session = {paths:{workDir:process.cwd()},sink:{violations:[]}};
    session.client = createClient({file:process.execPath,args:['--input-type=module','-e',${JSON.stringify(fixture)}],
      onNotification:(method,params)=>session.onTurnEvent?.(method,params)});
    try {
      await runTurn(session,{model:'fixture',messages:[],timeoutMs:1000,
        onProgress:()=>{throw Object.assign(new Error('revoked'),{code:'AI_FORBIDDEN'});}});
      throw new Error('Turn unexpectedly completed');
    } catch (error) {
      if (error.code !== 'AI_FORBIDDEN') throw error;
      process.stdout.write('handled');
    } finally { session.client.close(); await session.client.exited; }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {encoding:'utf8',timeout:10000});
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/handled$/);
});
