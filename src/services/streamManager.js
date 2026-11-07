import { formatDbError } from '../database/sqliteWrites.js';
import { resolveBudget } from '../utils/env.js';
import { randomUUID } from 'node:crypto';
import { expiryEpoch } from '../utils/stalker.js';

const REDIS_KEY_STREAMS = 'iptv:streams';
const REDIS_PREFIX_USER = 'iptv:user_idx:';
const REDIS_PREFIX_CONTROL = 'iptv:stream_control:';
const REDIS_TOUCH_SCRIPT = `
local json = redis.call('HGET', KEYS[1], ARGV[1])
if not json then return 0 end
local data = cjson.decode(json)
data.last_activity = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(data))
return 1`;
const REDIS_RESERVE_SCRIPT = `
local data = cjson.decode(ARGV[1])
local providers = cjson.decode(ARGV[2])
local userMax = tonumber(ARGV[3]) or 0
local streams = redis.call('HVALS', KEYS[1])
local userSessions = {}
local providerSessions = {}
local active = {}
local userCount = 0
for _, json in ipairs(streams) do
  local stream = cjson.decode(json)
  if stream.user_id == data.user_id then
    local key = cjson.encode({stream.channel_name, stream.ip, stream.provider_id})
    if not userSessions[key] then userCount = userCount + 1; userSessions[key] = true end
    if stream.channel_name == data.channel_name and stream.ip == data.ip then active[tostring(stream.provider_id)] = true end
  end
  local providerKey = tostring(stream.provider_id)
  if not providerSessions[providerKey] then providerSessions[providerKey] = {} end
  providerSessions[providerKey][cjson.encode({stream.channel_name, stream.ip, stream.user_id})] = true
end
local userFull = false
for _, provider in ipairs(providers) do
  local id = tostring(provider.id)
  local providerMax = tonumber(provider.max_connections) or 0
  local count = 0
  for _ in pairs(providerSessions[id] or {}) do count = count + 1 end
  if active[id] or userMax <= 0 or userCount < userMax then
    if active[id] or providerMax <= 0 or count < providerMax then
      data.provider_id = provider.id
      redis.call('HSET', KEYS[1], data.id, cjson.encode(data))
      redis.call('SET', KEYS[2], data.id)
      local result = {id}
      for _, json in ipairs(streams) do
        local stream = cjson.decode(json)
        if stream.user_id == data.user_id and stream.channel_name == data.channel_name and stream.ip == data.ip and tostring(stream.provider_id) == id then
          table.insert(result, stream.id)
        end
      end
      return result
    end
  else userFull = true end
end
if userFull then return 'user' end
return 'provider'`;
const REDIS_DELETE_INDEX_IF_MATCH_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;
const REDIS_RECOVER_OWNER_SCRIPT = `
local json = redis.call('HGET', KEYS[1], ARGV[1])
if not json then return 0 end
local stream = cjson.decode(json)
local owner = stream.owner_id or ('legacy:' .. tostring(stream.worker_pid))
if owner ~= ARGV[2] or stream.owner_id == ARGV[3] then return 0 end
local index = ARGV[4] .. stream.user_id .. ':' .. stream.ip
if redis.call('GET', index) == ARGV[1] then redis.call('DEL', index) end
return redis.call('HDEL', KEYS[1], ARGV[1])`;
// `Number(raw || default)` let a value with a unit — the shape operators keep
// writing — through as NaN, and every comparison against NaN is false: the
// inactivity sweep switched itself off, the touch throttle stopped throttling
// and every ffmpeg progress event became an UPDATE again. That write
// amplification is the contention this whole change set is about, so the one
// file on the hot path must not be the one still parsing by hand.
//
// `0` is kept as a real setting here — it is what the guard in isStale() reads,
// and it means "never reap on inactivity", which a long recording needs.
// resolveBudget refuses 0, so it is recognised before asking.
const DISABLED = /^\s*0+\s*$/;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 2 * 60 * 1000;
const STREAM_INACTIVITY_TIMEOUT_MS = DISABLED.test(String(process.env.STREAM_INACTIVITY_TIMEOUT_MS ?? ''))
  ? 0
  : resolveBudget(process.env.STREAM_INACTIVITY_TIMEOUT_MS, DEFAULT_INACTIVITY_TIMEOUT_MS, 1000,
    Number.MAX_SAFE_INTEGER, 'STREAM_INACTIVITY_TIMEOUT_MS');
// No such reading for the age cap: 0 would make every session with a start time
// instantly stale, which is a typo's result rather than anybody's intent.
const STREAM_MAX_AGE_MS = resolveBudget(
  process.env.STREAM_MAX_AGE_MS, 24 * 60 * 60 * 1000, 1000, Number.MAX_SAFE_INTEGER, 'STREAM_MAX_AGE_MS');
// ffmpeg emits `progress` roughly once per second per stream, and every one of
// those used to become an UPDATE on the shared database. Only the inactivity
// timeout depends on the value, so refreshing it far more often than that is
// pure write amplification — and the failing updates showed up as
// "DB Touch Error: database is locked" whenever a long write transaction ran.
// A session removed by another worker's stale sweep leaves this worker's entry
// behind, so the map is pruned instead of growing for the process lifetime.
const STREAM_TOUCH_MAP_LIMIT = 10000;
const STREAM_STALE_CLEANUP_CONCURRENCY = 4;
const STREAM_STALE_CLEANUP_RETRY_MS = 30000;
// Half the inactivity timeout, so a session can never expire because its
// refresh was throttled. With the sweep switched off there is nothing to stay
// under, and the derived default is floored rather than clamped to it.
const STREAM_TOUCH_CEILING_MS = STREAM_INACTIVITY_TIMEOUT_MS > 0
  ? Math.max(1000, Math.floor(STREAM_INACTIVITY_TIMEOUT_MS / 2))
  : Number.MAX_SAFE_INTEGER;
// With the sweep switched off there is no timeout to stay under — but there is
// still one shared database, and a quarter of nothing floors to one second,
// which is one UPDATE per ffmpeg progress event per stream: exactly the write
// amplification the throttle exists to remove. Switching off the reaper must
// not switch that back on, so the window the default timeout would have given
// is the basis instead.
const STREAM_TOUCH_BASIS_MS = STREAM_INACTIVITY_TIMEOUT_MS > 0
  ? STREAM_INACTIVITY_TIMEOUT_MS
  : DEFAULT_INACTIVITY_TIMEOUT_MS;
const STREAM_TOUCH_MIN_INTERVAL_MS = resolveBudget(
  process.env.STREAM_TOUCH_MIN_INTERVAL_MS,
  Math.min(Math.max(1000, Math.floor(STREAM_TOUCH_BASIS_MS / 4)), STREAM_TOUCH_CEILING_MS),
  1000, STREAM_TOUCH_CEILING_MS, 'STREAM_TOUCH_MIN_INTERVAL_MS');
// A heartbeat whose write failed must not burn the whole window. The latency
// connection gives up on a contended lock after a few hundred milliseconds, so
// a long write transaction elsewhere can fail several in a row — and with a
// full window between attempts only a handful fit inside the inactivity
// timeout, after which another worker's sweep reaps a session that is still
// playing. Retrying on every progress event would instead hammer the database
// that is already contended, so a failure waits a short fraction of the window.
const STREAM_TOUCH_RETRY_INTERVAL_MS = Math.max(1000, Math.floor(STREAM_TOUCH_MIN_INTERVAL_MS / 10));

class StreamManager {
  constructor() {
    this.db = null;
    this.redis = null;
    this.pid = process.pid;
    this.ownerId = randomUUID();
    this.instanceId = process.env.IPTV_STREAM_INSTANCE_ID || this.ownerId;
    this.pendingTerminations = new Map();
    this.unreachableTerminations = new Map();
    this.sessionPredecessors = new Map();
    this.staleCleanupPending = new Map();
    this.staleCleanupRetryAt = new Map();
    this.localStreams = new Map();
    this.lastTouchAt = new Map();
  }

  /**
   * @param {object} db shared connection for stream bookkeeping
   * @param {object|null} redisClient
   * @param {object|null} [latencyDb] connection for the activity heartbeat. It
   *        gives up on a contended lock quickly, because better-sqlite3 blocks
   *        the event loop while it waits and this worker is pumping streams.
   *        Falls back to `db` when not supplied (tests, Redis mode).
   */
  init(db, redisClient, latencyDb = null) {
    this.db = db;
    this.latencyDb = latencyDb || db;
    this.redis = redisClient;
    this.redisControlReady = this.redis?.duplicate ? this.startRedisControl() : Promise.resolve();
    if (this.redis) {
      console.info(`⚡ StreamManager using Redis (Worker ${this.pid})`);
    } else {
      console.info(`💾 StreamManager using SQLite (Worker ${this.pid})`);
      if (this.db) {
        try {
          this.stmtAdd = this.db.prepare(`
            INSERT OR REPLACE INTO current_streams (id, user_id, username, channel_name, start_time, last_activity, ip, worker_pid, provider_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          this.stmtRemove = this.db.prepare('DELETE FROM current_streams WHERE id = ?');
          this.stmtCleanup = this.db.prepare('SELECT id FROM current_streams WHERE user_id = ? AND ip = ?');
          this.stmtFindSameSession = this.db.prepare('SELECT id FROM current_streams WHERE user_id = ? AND ip = ? AND channel_name = ? AND provider_id = ? AND id != ?');
          this.stmtGetAll = this.db.prepare('SELECT * FROM current_streams');
          this.stmtCountUser = this.db.prepare('SELECT COUNT(*) as count FROM (SELECT DISTINCT channel_name, ip, provider_id FROM current_streams WHERE user_id = ?)');
          this.stmtCountProvider = this.db.prepare('SELECT COUNT(*) as count FROM (SELECT DISTINCT channel_name, ip, user_id FROM current_streams WHERE provider_id = ?)');
          this.stmtIsActive = this.db.prepare('SELECT 1 FROM current_streams WHERE user_id = ? AND ip = ? AND channel_name = ? AND provider_id = ? LIMIT 1');
          this.stmtTouch = this.latencyDb.prepare('UPDATE current_streams SET last_activity = ? WHERE id = ?');
          this.stmtGetById = this.db.prepare('SELECT * FROM current_streams WHERE id = ?');
          this.stmtDeleteByPid = this.db.prepare('DELETE FROM current_streams WHERE worker_pid = ?');
        } catch (e) {
          console.error('Failed to prepare statements:', e);
        }
      }
    }
  }

  async startRedisControl() {
    this.redisSubscriber = this.redis.duplicate();
    this.redisSubscriber.on('error', error => console.error('Redis stream control error:', error.message));
    await this.redisSubscriber.connect();
    await this.redisSubscriber.subscribe(`${REDIS_PREFIX_CONTROL}${this.ownerId}`, async json => {
      try {
        const message = JSON.parse(json);
        if (message.type === 'stream_terminated') this.handleTerminationReply(message);
        else if (message.type === 'terminate_stream') {
          const success = await this.remove(message.streamId, { localOnly: true });
          await this.redis.publish(`${REDIS_PREFIX_CONTROL}${message.replyOwner}`, JSON.stringify({
            type: 'stream_terminated', requestId: message.requestId, success
          }));
        }
      } catch (error) { console.error('Redis stream termination error:', error.message); }
    });
  }

  async reserve(id, user, channelName, ip, resource, providers, options = {}) {
    await this.cleanupStaleStreams();
    const data = { id, user_id: user.id, username: user.username, channel_name: channelName,
      start_time: Date.now(), last_activity: Date.now(), ip, worker_pid: this.pid, owner_id: this.ownerId, instance_id: this.instanceId };
    let provider;
    let predecessors = [];
    let error = 'provider';
    if (this.redis) {
      await this.redisControlReady;
      if (resource) this.localStreams.set(id, resource);
      const selected = await this.redis.eval(REDIS_RESERVE_SCRIPT, {
        keys: [REDIS_KEY_STREAMS, `${REDIS_PREFIX_USER}${user.id}:${ip}`],
        arguments: [JSON.stringify(data), JSON.stringify(providers), String(user.max_connections || 0)]
      });
      provider = providers.find(candidate => String(candidate.id) === String(selected?.[0]));
      if (Array.isArray(selected)) predecessors = selected.slice(1);
      if (!provider) error = selected;
    } else if (this.db) {
      this.db.transaction(() => {
        const userCount = this.stmtCountUser.get(user.id).count;
        for (const candidate of providers) {
          const active = this.stmtIsActive.get(user.id, ip, channelName, candidate.id);
          if (!active && user.max_connections > 0 && userCount >= user.max_connections) { error = 'user'; continue; }
          if (!active && candidate.max_connections > 0 && this.stmtCountProvider.get(candidate.id).count >= candidate.max_connections) continue;
          predecessors = this.stmtFindSameSession.all(user.id, ip, channelName, candidate.id, id).map(stream => stream.id);
          this.stmtAdd.run(id, user.id, user.username ?? null, channelName, data.start_time, data.last_activity, ip, this.pid, candidate.id);
          provider = candidate;
          break;
        }
      }).immediate();
    } else throw new Error('Stream accounting is unavailable');
    if (!provider) { this.localStreams.delete(id); return { error }; }
    if (resource && !this.redis) this.localStreams.set(id, resource);
    this.sessionPredecessors.set(id, predecessors);
    this.lastTouchAt.set(id, data.last_activity);
    if (options.dedupe !== false) await this.cleanupSession(user.id, ip, channelName, provider.id, id);
    const current = this.db.prepare(`SELECT * FROM ${user.is_admin ? 'admin_users' : 'users'} WHERE id = ?`).get(user.id);
    const expires = expiryEpoch(current?.expiry_date);
    let authorized = current?.is_active && (!expires || expires > Date.now() / 1000) &&
      Number(current.token_version || 0) === Number(user.token_version || 0);
    if (authorized && user.is_share_guest) {
      const share = this.db.prepare('SELECT * FROM shared_links WHERE token = ? AND user_id = ?').get(user.resource_token || options.sourceToken, user.id);
      const now = Date.now() / 1000;
      let channels;
      try { channels = JSON.parse(share?.channels); } catch { channels = []; }
      authorized = share && (!share.start_time || now >= share.start_time) && (!share.end_time || now <= share.end_time) &&
        Array.isArray(channels) && channels.some(id => Number(id) === Number(options.channelId));
    }
    if (!authorized || resource?.destroyed) {
      await this.remove(id);
      return { error: 'cancelled' };
    }
    return { provider };
  }

  async add(id, user, channelName, ip, resource = null, providerId = 0, options = {}) {
    const { dedupe = true } = options;
    const data = {
      id,
      user_id: user.id,
      username: user.username,
      channel_name: channelName,
      start_time: Date.now(),
      last_activity: Date.now(),
      ip,
      worker_pid: this.pid,
      owner_id: this.ownerId,
      instance_id: this.instanceId,
      provider_id: providerId
    };

    if (dedupe) {
      await this.cleanupSession(user.id, ip, channelName, providerId, id);
    }

    if (this.redis) {
      try {
        await this.redisControlReady;
        const json = JSON.stringify(data);
        await this.redis.hSet(REDIS_KEY_STREAMS, id, json);
        // Set User Index for fast cleanup
        await this.redis.set(`${REDIS_PREFIX_USER}${user.id}:${ip}`, id);
        // Optional: Expire index after 24h to prevent trash?
        // Actually, cleanup removes it.
      } catch (e) {
        console.error('Redis Add Error:', e);
      }
    } else if (this.db) {
      try {
        this.stmtAdd.run(id, user.id, user.username, channelName, data.start_time, data.last_activity, ip, this.pid, providerId);
      } catch (e) {
        console.error('DB Add Error:', formatDbError(e));
      }
    }

    if (resource) {
      this.localStreams.set(id, resource);
    }

    // add() already stored last_activity; start the throttle window here.
    this.lastTouchAt.set(id, data.last_activity);
  }

  async cleanupSession(userId, ip, channelName, providerId = 0, excludeId = null) {
    if (!userId || !ip || !channelName) return;
    if (excludeId && this.sessionPredecessors.has(excludeId)) {
      for (const id of this.sessionPredecessors.get(excludeId)) await this.remove(id);
      return;
    }

    if (this.redis) {
      try {
        const all = await this.getAll();
        const sameSessionIds = all
          .filter(stream =>
            stream.user_id === userId &&
            stream.ip === ip &&
            stream.channel_name === channelName &&
            stream.provider_id === providerId &&
            stream.id !== excludeId
          )
          .map(stream => stream.id);

        for (const sessionId of sameSessionIds) {
          await this.remove(sessionId);
        }
      } catch (e) {
        console.error('Redis Session Cleanup Error:', e);
      }
      return;
    }

    if (this.db) {
      try {
        const rows = this.stmtFindSameSession.all(userId, ip, channelName, providerId, excludeId || '');
        for (const row of rows) {
          await this.remove(row.id);
        }
      } catch (e) {
        console.error('DB Session Cleanup Error:', formatDbError(e));
      }
    }
  }

  handleTerminationReply(message) {
    this.pendingTerminations.get(message.requestId)?.(message.success === true);
  }

  async requestOwnerTermination(stream) {
    const requestId = randomUUID();
    let acknowledged = false;
    let timer;
    const reply = new Promise(resolve => {
      this.pendingTerminations.set(requestId, success => { acknowledged = true; resolve(success); });
      timer = setTimeout(() => resolve(false), 5000);
      timer.unref?.();
    });
    try {
      const message = { type: 'terminate_stream', requestId, streamId: stream.id, targetPid: stream.worker_pid, replyPid: this.pid, replyOwner: this.ownerId };
      if (this.redis && stream.owner_id) {
        await this.redisControlReady;
        await this.redis.publish(`${REDIS_PREFIX_CONTROL}${stream.owner_id}`, JSON.stringify(message));
      } else if (this.forwardTermination) await this.forwardTermination(message);
      else if (typeof process.send === 'function') process.send(message);
      else return false;
      return await reply;
    } finally {
      clearTimeout(timer);
      this.pendingTerminations.delete(requestId);
      if (!acknowledged) this.unreachableTerminations.set(stream.id, stream.owner_id || `legacy:${stream.worker_pid}`);
      else this.unreachableTerminations.delete(stream.id);
      if (this.unreachableTerminations.size > STREAM_TOUCH_MAP_LIMIT) this.unreachableTerminations.clear();
    }
  }

  async recoverStoppedOwner(id, expectedOwner) {
    if (this.unreachableTerminations.get(id) !== expectedOwner || this.localStreams.has(id) || expectedOwner === this.ownerId) return false;
    if (!this.redis) return false;
    const json = await this.redis.hGet(REDIS_KEY_STREAMS, id);
    const stream = json && JSON.parse(json);
    if (!stream || (stream.instance_id === this.instanceId && this.isWorkerAlive(stream.worker_pid))) return false;
    const removed = await this.redis.eval(REDIS_RECOVER_OWNER_SCRIPT, {
      keys: [REDIS_KEY_STREAMS], arguments: [id, expectedOwner, this.ownerId, REDIS_PREFIX_USER]
    });
    if (removed) this.unreachableTerminations.delete(id);
    return Boolean(removed);
  }

  async remove(id, { localOnly = false, ownerStopped = false } = {}) {
    const json = this.redis ? await this.redis.hGet(REDIS_KEY_STREAMS, id) : null;
    const stream = this.redis ? (json ? JSON.parse(json) : null) : this.stmtGetById?.get(id);
    const unknownLegacy = this.redis && stream && !stream.owner_id && !this.localStreams.has(id);
    if (unknownLegacy && !ownerStopped) {
      if (!localOnly) this.unreachableTerminations.set(id, `legacy:${stream.worker_pid}`);
      return false;
    }
    const foreign = stream && (this.redis ? Boolean(stream.owner_id && stream.owner_id !== this.ownerId) : stream.worker_pid && stream.worker_pid !== this.pid);
    if (foreign && !ownerStopped && (this.redis || this.isWorkerAlive(stream.worker_pid))) {
      if (localOnly) return false;
      return this.requestOwnerTermination(stream);
    }
    // Kill local resource if exists
    this.destroyLocalStream(id);

    if (this.redis) {
      try {
        const json = await this.redis.hGet(REDIS_KEY_STREAMS, id);
        if (json) {
          const data = JSON.parse(json);
          const indexKey = `${REDIS_PREFIX_USER}${data.user_id}:${data.ip}`;
          await this.redis.eval(REDIS_DELETE_INDEX_IF_MATCH_SCRIPT, {
            keys: [indexKey],
            arguments: [String(id)]
          });
        }
        await this.redis.hDel(REDIS_KEY_STREAMS, id);
      } catch (e) {
        console.error('Redis Remove Error:', e);
        return false;
      }
    } else if (this.db) {
      try {
        this.stmtRemove.run(id);
      } catch { return false; }
    }

    this.lastTouchAt.delete(id);
    this.sessionPredecessors.delete(id);
    return true;
  }

  destroyLocalStream(id) {
    const resource = this.localStreams.get(id);
    if (resource) {
      this.localStreams.delete(id);
      try {
        if (typeof resource.destroy === 'function') resource.destroy();
        else if (typeof resource.end === 'function') resource.end();
        else if (typeof resource.kill === 'function') resource.kill('SIGKILL');
      } catch (e) { console.error('Error killing stream resource:', e); }
    }

  }

  async cleanupUser(userId, ip) {
    if (this.redis) {
      try {
        // Check index
        const oldId = await this.redis.get(`${REDIS_PREFIX_USER}${userId}:${ip}`);
        if (oldId) {
          // Instead of just deleting from Redis, call remove() to trigger resource kill if local
          await this.remove(oldId);
        }
      } catch (e) {
        console.error('Redis Cleanup Error:', e);
      }
    } else if (this.db) {
      try {
        const row = this.stmtCleanup.get(userId, ip);
        if (row) {
          await this.remove(row.id);
        }
      } catch (e) {
        console.error('DB Cleanup Error:', formatDbError(e));
      }
    }
  }

  /**
   * Refresh the activity timestamp of a session.
   * @param {string} id
   * @param {object} [options]
   * @param {boolean} [options.force=false] write even inside the throttle window
   */
  async touch(id, options = {}) {
    const now = Date.now();

    if (!options.force) {
      const previous = this.lastTouchAt.get(id) || 0;
      if (now - previous < STREAM_TOUCH_MIN_INTERVAL_MS) return;
    }
    // Claim the window before the write, so concurrent progress events cannot
    // pile up behind an in-flight one — the Redis path awaits two round trips
    // here, and every caller is fire-and-forget. A write that then fails hands
    // the window back below.
    this.lastTouchAt.set(id, now);

    let written = true;
    if (this.redis) {
      try {
        await this.redis.eval(REDIS_TOUCH_SCRIPT, { keys: [REDIS_KEY_STREAMS], arguments: [id, String(now)] });
      } catch (e) {
        written = false;
        console.error('Redis Touch Error:', e);
      }
    } else if (this.db) {
      try {
        this.stmtTouch.run(now, id);
      } catch (e) {
        written = false;
        console.error('DB Touch Error:', formatDbError(e));
      }
    }

    // A failed write must not burn the whole window, and remove() may have
    // dropped the entry while the write was in flight — do not resurrect it.
    if (!written && this.lastTouchAt.has(id)) {
      this.lastTouchAt.set(id, now - STREAM_TOUCH_MIN_INTERVAL_MS + STREAM_TOUCH_RETRY_INTERVAL_MS);
    } else if (!written) {
      this.lastTouchAt.delete(id);
    }
    if (this.lastTouchAt.size > STREAM_TOUCH_MAP_LIMIT) this.pruneTouchTimestamps(now);
  }

  /**
   * Drop throttle timestamps of sessions that can no longer be active. A
   * session another worker's stale sweep removed never reaches remove() here,
   * so without this the map only ever grows.
   */
  pruneTouchTimestamps(now = Date.now()) {
    for (const [id, at] of this.lastTouchAt) {
      if (now - at > STREAM_MAX_AGE_MS) this.lastTouchAt.delete(id);
    }
    // Still over the limit means the entries are genuinely recent; dropping
    // them only costs one extra activity write per affected session.
    if (this.lastTouchAt.size > STREAM_TOUCH_MAP_LIMIT) this.lastTouchAt.clear();
  }

  isWorkerAlive(workerPid) {
    if (!workerPid || workerPid === this.pid) return true;
    try {
      process.kill(workerPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  hasActiveLocalResource(streamId) {
    if (!streamId) return false;
    const resource = this.localStreams.get(streamId);
    if (!resource) return false;

    if (typeof resource.destroyed === 'boolean') return !resource.destroyed;
    if (typeof resource.writableEnded === 'boolean') return !resource.writableEnded;
    if (typeof resource.readableEnded === 'boolean') return !resource.readableEnded;
    return true;
  }

  isStale(stream, now = Date.now()) {
    if (!stream) return false;
    const local = this.redis && stream.owner_id ? stream.owner_id === this.ownerId : stream.worker_pid === this.pid;
    if (!this.redis && !this.isWorkerAlive(stream.worker_pid)) return true;
    if (local && this.hasActiveLocalResource(stream.id)) return false;

    const startTime = Number(stream.start_time || 0);
    const lastActivity = Number(stream.last_activity || startTime || 0);
    if (!lastActivity) return false;

    if (STREAM_INACTIVITY_TIMEOUT_MS > 0 && now - lastActivity > STREAM_INACTIVITY_TIMEOUT_MS) return true;
    if (startTime && now - startTime > STREAM_MAX_AGE_MS) return true;
    return false;
  }

  async cleanupStaleStreams() {
    const now = Date.now();

    if (this.redis) {
      try {
        const all = await this.getAll();
        for (const [id, retryAt] of this.staleCleanupRetryAt) {
          if (retryAt <= now && !this.staleCleanupPending.has(id)) this.staleCleanupRetryAt.delete(id);
        }
        for (const stream of all) {
          if (!this.isStale(stream, now)) continue;
          if (stream.owner_id === this.ownerId || (!stream.owner_id && this.localStreams.has(stream.id))) {
            await this.remove(stream.id);
            continue;
          }
          if (this.staleCleanupPending.has(stream.id) || this.staleCleanupRetryAt.has(stream.id) ||
              this.staleCleanupPending.size >= STREAM_STALE_CLEANUP_CONCURRENCY || this.staleCleanupRetryAt.size >= STREAM_TOUCH_MAP_LIMIT) continue;
          // Foreign-owner ACKs must not hold up accounting or a new reservation.
          this.staleCleanupRetryAt.set(stream.id, now + STREAM_STALE_CLEANUP_RETRY_MS);
          const pending = this.remove(stream.id)
            .then(removed => { if (removed) this.staleCleanupRetryAt.delete(stream.id); })
            .catch(error => console.error('Redis stale stream termination error:', error.message))
            .finally(() => this.staleCleanupPending.delete(stream.id));
          this.staleCleanupPending.set(stream.id, pending);
        }
      } catch (e) {
        console.error('Redis stale cleanup error:', e);
      }
      return;
    }

    if (this.db) {
      try {
        const all = this.stmtGetAll.all();
        const staleIds = all.filter(stream => this.isStale(stream, now)).map(stream => stream.id);
        for (const staleId of staleIds) {
          await this.remove(staleId);
        }
      } catch (e) {
        console.error('DB stale cleanup error:', e.message);
      }
    }
  }

  async cleanupWorkerStreams(workerPid) {
    if (!workerPid) return;

    if (this.redis) {
      try {
        const all = await this.getAll();
        for (const stream of all) {
          if (stream.worker_pid === workerPid && stream.instance_id === this.instanceId) {
            // The primary can prove its own exited worker is dead, including in Redis mode.
            await this.remove(stream.id, { ownerStopped: !this.isWorkerAlive(workerPid) });
          }
        }
      } catch (e) {
        console.error('Redis worker cleanup error:', e);
      }
      return;
    }

    if (this.db) {
      try {
        this.stmtDeleteByPid.run(workerPid);
      } catch (e) {
        console.error('DB worker cleanup error:', e.message);
      }
    }
  }

  async getAll({ strict = false } = {}) {
    if (this.redis) {
      try {
        const all = await this.redis.hGetAll(REDIS_KEY_STREAMS);
        return Object.values(all).map(json => JSON.parse(json));
      } catch (e) {
        console.error('Redis GetAll Error:', e);
        if (strict) throw e;
        return [];
      }
    } else if (this.db) {
      try {
        return this.stmtGetAll.all();
      } catch (e) {
        if (strict) throw e;
        return [];
      }
    }
    return [];
  }

  async getUserConnectionCount(userId) {
    await this.cleanupStaleStreams();

    if (this.redis) {
      try {
        // Since we don't have a direct index for count, we filter getAll.
        // Optimization: Maintain a separate counter in Redis if performance becomes an issue.
        const all = await this.getAll();
        const userStreams = all.filter(s => s.user_id === userId);

        // Smart Counting: Count unique sessions (Content + IP + Provider)
        // This allows a single user to open multiple connections (sockets) for the same content
        // on the same IP without consuming multiple "slots".
        // Optimization: Use template strings instead of JSON.stringify for significantly faster Set operations
        const uniqueSessions = new Set(userStreams.map(s =>
          `${s.channel_name}|${s.ip}|${s.provider_id}`
        ));

        return uniqueSessions.size;
      } catch (e) {
        console.error('Redis Count Error:', e);
        return 0;
      }
    } else if (this.db) {
      try {
        const res = this.stmtCountUser.get(userId);
        return res ? res.count : 0;
      } catch (e) {
        console.error('DB Count Error:', e);
        return 0;
      }
    }
    return 0;
  }

  async getProviderConnectionCount(providerId) {
    if (!providerId) return 0;
    await this.cleanupStaleStreams();

    if (this.redis) {
      try {
        const all = await this.getAll();
        const providerStreams = all.filter(s => s.provider_id === providerId);
        // Smart Counting: Count unique sessions (Channel + IP + User)
        // Optimization: Use template strings instead of JSON.stringify for significantly faster Set operations
        const uniqueSessions = new Set(providerStreams.map(s =>
          `${s.channel_name}|${s.ip}|${s.user_id}`
        ));
        return uniqueSessions.size;
      } catch (e) {
        console.error('Redis Provider Count Error:', e);
        return 0;
      }
    } else if (this.db) {
      try {
        const res = this.stmtCountProvider.get(providerId);
        return res ? res.count : 0;
      } catch (e) {
        console.error('DB Provider Count Error:', e);
        return 0;
      }
    }
    return 0;
  }

  async isSessionActive(userId, ip, channelName, providerId) {
    await this.cleanupStaleStreams();

    if (this.redis) {
      try {
        const all = await this.getAll();
        return all.some(s => s.user_id === userId && s.ip === ip && s.channel_name === channelName && s.provider_id === providerId);
      } catch {
        return false;
      }
    } else if (this.db) {
      try {
        return !!this.stmtIsActive.get(userId, ip, channelName, providerId);
      } catch {
        return false;
      }
    }
    return false;
  }
}

export default new StreamManager();
