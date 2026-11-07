import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from 'redis';
import singleton from '../../src/services/streamManager.js';
import Database from 'better-sqlite3';

// Run against an isolated real server: REDIS_TEST_BINARY=/path/to/redis-server npm test -- this-file.
describe.skipIf(!process.env.REDIS_TEST_BINARY)('StreamManager with real Redis and independent owners', () => {
  let directory, server, owner, other, accounts;
  const user = { id: 1, username: 'one', max_connections: 1 };
  const provider = { id: 1, max_connections: 1 };
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'iptv-stream-redis-'));
    const socket = path.join(directory, 'redis.sock');
    server = spawn(process.env.REDIS_TEST_BINARY, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    for (let attempt = 0; ; attempt++) {
      try { await access(socket); break; } catch {
        if (attempt >= 100) throw new Error('Test Redis did not start');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    accounts = new Database(':memory:');
    accounts.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER, token_version INTEGER, expiry_date TEXT);
      INSERT INTO users VALUES (1,1,0,NULL), (2,1,0,NULL), (3,1,0,NULL)`);
    owner = new singleton.constructor();
    other = new singleton.constructor();
    for (const manager of [owner, other]) {
      const client = createClient({ socket: { path: socket } });
      await client.connect();
      manager.init(accounts, client);
      await manager.redisControlReady;
    }
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await owner.redis.flushDb();
    for (const manager of [owner, other]) {
      manager.localStreams.clear(); manager.lastTouchAt.clear();
      manager.sessionPredecessors.clear();
    }
  });
  afterAll(async () => {
    for (const manager of [owner, other]) {
      if (manager?.redisSubscriber?.isOpen) await manager.redisSubscriber.close();
      if (manager?.redis?.isOpen) await manager.redis.close();
    }
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    accounts?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['user', 'provider'])('admits one concurrent reservation at the %s limit', async limit => {
    const results = await Promise.all([
      owner.reserve('a', user, 'A', 'ip-a', null, [{ ...provider, max_connections: limit === 'provider' ? 1 : 0 }], { dedupe: false }),
      other.reserve('b', limit === 'user' ? user : { ...user, id: 2 }, 'B', 'ip-b', null, [{ ...provider, max_connections: limit === 'provider' ? 1 : 0 }], { dedupe: false })
    ]);
    expect(results.filter(result => result.provider)).toHaveLength(1);
    expect(await owner.getAll()).toHaveLength(1);
  });

  it('reuses one logical session across independent owners', async () => {
    const results = await Promise.all([
      owner.reserve('a', user, 'Same', 'ip', null, [provider], { dedupe: false }),
      other.reserve('b', user, 'Same', 'ip', null, [provider], { dedupe: false })
    ]);
    expect(results.every(result => result.provider)).toBe(true);
    expect(await owner.getAll()).toHaveLength(2);
    expect(await owner.getUserConnectionCount(1)).toBe(1);
    expect(await owner.getProviderConnectionCount(1)).toBe(1);
  });

  it('leaves one winning stream when concurrent owners deduplicate the same session', async () => {
    const resources = [0, 1].map(() => ({ destroyed: false, destroy() { this.destroyed = true; } }));
    await Promise.all([
      owner.reserve('same-a', user, 'Same', 'ip', resources[0], [provider]),
      other.reserve('same-b', user, 'Same', 'ip', resources[1], [provider])
    ]);
    expect(resources.filter(resource => !resource.destroyed)).toHaveLength(1);
    expect(await owner.getAll()).toHaveLength(1);
  });

  it('does not resurrect a stream when a queued heartbeat races with removal', async () => {
    await owner.reserve('touch-race', user, 'A', 'ip', null, [provider]);
    const hGet = owner.redis.hGet.bind(owner.redis);
    const evaluate = owner.redis.eval.bind(owner.redis);
    let resume;
    vi.spyOn(owner.redis, 'hGet').mockImplementation(async (...args) => {
      const value = await hGet(...args);
      if (resume) return value;
      await new Promise(resolve => { resume = resolve; });
      return value;
    });
    vi.spyOn(owner.redis, 'eval').mockImplementation(async (...args) => {
      if (args[0].includes('data.last_activity =')) await new Promise(resolve => { resume = resolve; });
      return evaluate(...args);
    });
    const pending = owner.touch('touch-race', { force: true });
    await vi.waitUntil(() => resume);
    await other.remove('touch-race');
    resume();
    await pending;
    expect(await owner.redis.hExists('iptv:streams', 'touch-race')).toBeFalsy();
  });

  it('atomically tries the next provider when the first account is full', async () => {
    await owner.reserve('full', { id: 3 }, 'Full', 'ip', null, [provider]);
    const results = await Promise.all([
      owner.reserve('a', user, 'A', 'ip-a', null, [provider, { id: 2, max_connections: 1 }], { dedupe: false }),
      other.reserve('b', { ...user, id: 2 }, 'B', 'ip-b', null, [provider, { id: 2, max_connections: 1 }], { dedupe: false })
    ]);
    expect(results.filter(result => result.provider)).toEqual([{ provider: { id: 2, max_connections: 1 } }]);
  });

  it('treats null provider limits as unlimited', async () => {
    expect(await owner.reserve('unlimited', { id: 1 }, 'A', 'ip', null, [{ id: 1, max_connections: null }])).toHaveProperty('provider.id', 1);
  });

  it('terminates the actual owner before removing its record even when process IDs match', async () => {
    const resource = { destroy: vi.fn() };
    await owner.reserve('foreign', user, 'A', 'ip', resource, [provider]);
    const hDel = owner.redis.hDel.bind(owner.redis);
    vi.spyOn(owner.redis, 'hDel').mockImplementation((...args) => {
      expect(resource.destroy).toHaveBeenCalledOnce();
      return hDel(...args);
    });
    expect(await other.remove('foreign')).toBe(true);
    expect(resource.destroy).toHaveBeenCalledOnce();
    expect(await other.getAll()).toHaveLength(0);
  });

  it('keeps accounting when an unreachable owner cannot confirm termination', async () => {
    await owner.reserve('unreachable', user, 'A', 'ip', null, [provider]);
    await owner.redisSubscriber.unsubscribe(`iptv:stream_control:${owner.ownerId}`);
    try {
      expect(await other.remove('unreachable')).toBe(false);
      expect(await other.getAll()).toHaveLength(1);
      expect(await other.recoverStoppedOwner('unreachable', 'wrong-owner')).toBe(false);
      const saved = await owner.redis.hGet('iptv:streams', 'unreachable');
      await owner.redis.hSet('iptv:streams', 'unreachable', JSON.stringify({ ...JSON.parse(saved), owner_id: 'changed-owner' }));
      expect(await other.recoverStoppedOwner('unreachable', owner.ownerId)).toBe(false);
      await owner.redis.hSet('iptv:streams', 'unreachable', saved);
      await owner.redis.set('iptv:user_idx:1:ip', 'newer-session');
      expect(await other.recoverStoppedOwner('unreachable', owner.ownerId)).toBe(true);
      expect(await owner.redis.get('iptv:user_idx:1:ip')).toBe('newer-session');
      expect(await other.getAll()).toHaveLength(0);
      expect(await other.reserve('replacement', user, 'New', 'ip', null, [provider])).toHaveProperty('provider.id', 1);
    } finally {
      await owner.redisSubscriber.close();
      await owner.startRedisControl();
    }
  }, 10000);

  it('does not bypass a live owner that replied with a negative acknowledgement', async () => {
    await owner.reserve('alive', user, 'A', 'ip', null, [provider]);
    vi.spyOn(owner, 'remove').mockResolvedValue(false);
    expect(await other.remove('alive')).toBe(false);
    expect(await other.recoverStoppedOwner('alive', owner.ownerId)).toBe(false);
    expect(await owner.redis.hExists('iptv:streams', 'alive')).toBeTruthy();
  });

  it('retains unknown legacy rows despite matching Docker process IDs', async () => {
    const resource = { destroyed: false, destroy() { this.destroyed = true; } };
    owner.localStreams.set('legacy-live', resource);
    await owner.redis.hSet('iptv:streams', 'legacy-live', JSON.stringify({ id: 'legacy-live', user_id: 1,
      channel_name: 'Legacy', ip: 'ip', provider_id: 1, worker_pid: other.pid }));
    expect(await other.remove('legacy-live')).toBe(false);
    expect(await other.remove('legacy-live', { localOnly: true })).toBe(false);
    expect(resource.destroyed).toBe(false);
    expect(await owner.redis.hExists('iptv:streams', 'legacy-live')).toBeTruthy();
  });

  it('recovers a confirmed stopped legacy owner without a UUID', async () => {
    await owner.redis.hSet('iptv:streams', 'legacy', JSON.stringify({ id: 'legacy', user_id: 1,
      channel_name: 'Legacy', ip: 'ip', provider_id: 1, worker_pid: 2147483647 }));
    other.forwardTermination = () => {};
    try {
      expect(await other.remove('legacy')).toBe(false);
      expect(await other.recoverStoppedOwner('legacy', 'legacy:2147483647')).toBe(true);
      expect(await other.getAll()).toHaveLength(0);
    } finally { delete other.forwardTermination; }
  }, 10000);

  it('does not reap another server instance with a coincident worker PID', async () => {
    const resource = { destroy: vi.fn() };
    await owner.reserve('foreign', user, 'A', 'ip', resource, [provider]);
    await other.cleanupWorkerStreams(owner.pid);
    expect(resource.destroy).not.toHaveBeenCalled();
    expect(await owner.getAll()).toHaveLength(1);
  });

  it('releases a confirmed exited worker from its own server instance', async () => {
    await owner.redis.hSet('iptv:streams', 'dead', JSON.stringify({
      id: 'dead', user_id: 1, ip: 'ip', channel_name: 'Dead', provider_id: 1,
      worker_pid: 2147483647, owner_id: 'exited', instance_id: owner.instanceId,
    }));
    await owner.cleanupWorkerStreams(2147483647);
    expect(await owner.getAll()).toHaveLength(0);
  });
});
