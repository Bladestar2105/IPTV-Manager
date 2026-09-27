import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each([false, true])('invalidates real cluster workers (EPG and all users: %s)', async epg => {
  const dir = mkdtempSync(join(tmpdir(), 'iptv-cache-cluster-'));
  const script = join(dir, 'cluster.mjs');
  const service = new URL('../src/services/cacheService.js', import.meta.url).href;
  writeFileSync(script, `
    import cluster from 'node:cluster';
    import * as cache from ${JSON.stringify(service)};
    let epgClears = 0;
    cache.startChannelsCacheInvalidation?.(() => epgClears++);
    if (cluster.isPrimary) {
      const workers = [cluster.fork(), cluster.fork()];
      const ready = new Set();
      cluster.on('message', (worker, message) => {
        if (message.type === 'ready') {
          ready.add(worker.id);
          if (ready.size === 2) workers[0].send({type:'clear'});
        }
        if (message.type === 'cleared') {
          // Both forwarded messages use the same ordered primary-to-worker pipe.
          workers[1].send({type:'inspect'});
        }
        if (message.type === 'result') {
          console.log(JSON.stringify({keys:message.keys,epgClears:message.epgClears}));
          workers.forEach(w => w.kill());
        }
      });
    } else {
      cache.channelsJsonCache.set('user_1_host','old');
      cache.channelsJsonCache.set('guest_1_host','old');
      cache.channelsJsonCache.set('user_2_host','keep');
      process.on('message', message => {
        if (message.type === 'clear') { cache.clearChannelsCache(${epg ? "undefined" : "1"}, {epg:${epg}}); process.send({type:'cleared'}); }
        if (message.type === 'inspect') process.send({type:'result',keys:[...cache.channelsJsonCache.keys()],epgClears});
      });
      process.send({type:'ready'});
    }
  `);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script], {timeout:5000});
    expect(JSON.parse(stdout.trim())).toEqual({keys: epg ? [] : ['user_2_host'],epgClears: epg ? 1 : 0});
  } finally { rmSync(dir, {recursive:true,force:true}); }
}, 10000);
