
const REDIS_KEY_STREAMS = 'iptv:streams';
const REDIS_PREFIX_USER = 'iptv:user_idx:';
const STREAM_INACTIVITY_TIMEOUT_MS = Number(process.env.STREAM_INACTIVITY_TIMEOUT_MS || 2 * 60 * 1000);
const STREAM_MAX_AGE_MS = Number(process.env.STREAM_MAX_AGE_MS || 24 * 60 * 60 * 1000);

class StreamManager {
  constructor() {
    this.db = null;
    this.redis = null;
    this.pid = process.pid;
    this.localStreams = new Map();
  }

  init(db, redisClient) {
    this.db = db;
    this.redis = redisClient;
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
          this.stmtTouch = this.db.prepare('UPDATE current_streams SET last_activity = ? WHERE id = ?');
          this.stmtGetById = this.db.prepare('SELECT * FROM current_streams WHERE id = ?');
          this.stmtDeleteByPid = this.db.prepare('DELETE FROM current_streams WHERE worker_pid = ?');
        } catch (e) {
          console.error('Failed to prepare statements:', e);
        }
      }
    }
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
      provider_id: providerId
    };

    if (dedupe) {
      await this.cleanupSession(user.id, ip, channelName, providerId, id);
    }

    if (this.redis) {
      try {
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
        console.error('DB Add Error:', e.message);
      }
    }

    if (resource) {
      this.localStreams.set(id, resource);
    }
  }

  async cleanupSession(userId, ip, channelName, providerId = 0, excludeId = null) {
    if (!userId || !ip || !channelName) return;

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
        console.error('DB Session Cleanup Error:', e.message);
      }
    }
  }

  async remove(id) {
    // Kill local resource if exists
    const resource = this.localStreams.get(id);
    if (resource) {
      try {
        if (typeof resource.destroy === 'function') resource.destroy();
        else if (typeof resource.end === 'function') resource.end();
        else if (typeof resource.kill === 'function') resource.kill('SIGKILL');
      } catch (e) { console.error('Error killing stream resource:', e); }
      this.localStreams.delete(id);
    }

    if (this.redis) {
      try {
        // We need to remove the user index too, but we don't have user_id/ip here easily without fetching first.
        // Optimization: Just remove the stream. The user index will just point to a non-existent stream, which is fine,
        // or will be overwritten next time.
        // Ideally we fetch, delete index, delete stream.
        const json = await this.redis.hGet(REDIS_KEY_STREAMS, id);
        if (json) {
          const data = JSON.parse(json);
          await this.redis.del(`${REDIS_PREFIX_USER}${data.user_id}:${data.ip}`);
          await this.redis.hDel(REDIS_KEY_STREAMS, id);
        }
      } catch (e) {
        console.error('Redis Remove Error:', e);
      }
    } else if (this.db) {
      try {
        this.stmtRemove.run(id);
      } catch { /* ignore */ }
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
        console.error('DB Cleanup Error:', e.message);
      }
    }
  }

  async touch(id) {
    const now = Date.now();

    if (this.redis) {
      try {
        const json = await this.redis.hGet(REDIS_KEY_STREAMS, id);
        if (!json) return;
        const data = JSON.parse(json);
        data.last_activity = now;
        await this.redis.hSet(REDIS_KEY_STREAMS, id, JSON.stringify(data));
      } catch (e) {
        console.error('Redis Touch Error:', e);
      }
    } else if (this.db) {
      try {
        this.stmtTouch.run(now, id);
      } catch (e) {
        console.error('DB Touch Error:', e.message);
      }
    }
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
    if (!this.isWorkerAlive(stream.worker_pid)) return true;
    if (stream.worker_pid === this.pid && this.hasActiveLocalResource(stream.id)) return false;

    const startTime = Number(stream.start_time || 0);
    const lastActivity = Number(stream.last_activity || 0);

    if (lastActivity > 0) {
      if (STREAM_INACTIVITY_TIMEOUT_MS > 0 && now - lastActivity > STREAM_INACTIVITY_TIMEOUT_MS) return true;
      return false;
    }

    if (startTime && STREAM_MAX_AGE_MS > 0 && now - startTime > STREAM_MAX_AGE_MS) return true;
    return false;
  }

  async cleanupStaleStreams() {
    const now = Date.now();

    if (this.redis) {
      try {
        const all = await this.getAll();
        const staleIds = all.filter(stream => this.isStale(stream, now)).map(stream => stream.id);
        for (const staleId of staleIds) {
          await this.remove(staleId);
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
          if (stream.worker_pid === workerPid) {
            await this.remove(stream.id);
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

  async getAll() {
    if (this.redis) {
      try {
        const all = await this.redis.hGetAll(REDIS_KEY_STREAMS);
        const parsed = Object.values(all).map(json => JSON.parse(json));
        const now = Date.now();
        const active = [];
        for (const stream of parsed) {
          if (this.isStale(stream, now)) await this.remove(stream.id);
          else active.push(stream);
        }
        return active;
      } catch (e) {
        console.error('Redis GetAll Error:', e);
        return [];
      }
    } else if (this.db) {
      try {
        return this.stmtGetAll.all();
      } catch {
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
