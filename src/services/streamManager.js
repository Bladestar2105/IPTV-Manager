
const REDIS_KEY_STREAMS = 'iptv:streams';
const REDIS_PREFIX_USER = 'iptv:user_idx:';

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
      console.log(`⚡ StreamManager using Redis (Worker ${this.pid})`);
    } else {
      console.log(`💾 StreamManager using SQLite (Worker ${this.pid})`);
      if (this.db) {
        try {
          this.stmtAdd = this.db.prepare(`
            INSERT OR REPLACE INTO current_streams (id, user_id, username, channel_name, start_time, ip, worker_pid, provider_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          this.stmtRemove = this.db.prepare('DELETE FROM current_streams WHERE id = ?');
          this.stmtCleanup = this.db.prepare('SELECT id FROM current_streams WHERE user_id = ? AND ip = ?');
          this.stmtGetAll = this.db.prepare('SELECT * FROM current_streams');
          this.stmtCountUser = this.db.prepare('SELECT COUNT(*) as count FROM (SELECT DISTINCT channel_name, ip, provider_id FROM current_streams WHERE user_id = ?)');
          this.stmtCountProvider = this.db.prepare('SELECT COUNT(*) as count FROM (SELECT DISTINCT channel_name, ip, user_id FROM current_streams WHERE provider_id = ?)');
          this.stmtIsActive = this.db.prepare('SELECT 1 FROM current_streams WHERE user_id = ? AND ip = ? AND channel_name = ? AND provider_id = ? LIMIT 1');
        } catch (e) {
          console.error('Failed to prepare statements:', e);
        }
      }
    }
  }

  async add(id, user, channelName, ip, resource = null, providerId = 0) {
    const data = {
      id,
      user_id: user.id,
      username: user.username,
      channel_name: channelName,
      start_time: Date.now(),
      ip,
      worker_pid: this.pid,
      provider_id: providerId
    };

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
        this.stmtAdd.run(id, user.id, user.username, channelName, data.start_time, ip, this.pid, providerId);
      } catch (e) {
        console.error('DB Add Error:', e.message);
      }
    }

    if (resource) {
      this.localStreams.set(id, resource);
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
      } catch (e) { /* ignore */ }
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

  async getAll() {
    if (this.redis) {
      try {
        const all = await this.redis.hGetAll(REDIS_KEY_STREAMS);
        return Object.values(all).map(json => JSON.parse(json));
      } catch (e) {
        console.error('Redis GetAll Error:', e);
        return [];
      }
    } else if (this.db) {
      try {
        return this.stmtGetAll.all();
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  async getUserConnectionCount(userId) {
    if (this.redis) {
      try {
        // Since we don't have a direct index for count, we filter getAll.
        // Optimization: Maintain a separate counter in Redis if performance becomes an issue.
        const all = await this.getAll();
        const userStreams = all.filter(s => s.user_id === userId);

        // Smart Counting: Count unique sessions (Content + IP + Provider)
        // This allows a single user to open multiple connections (sockets) for the same content
        // on the same IP without consuming multiple "slots".
        const uniqueSessions = new Set(userStreams.map(s =>
          JSON.stringify({ c: s.channel_name, i: s.ip, p: s.provider_id })
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

    if (this.redis) {
      try {
        const all = await this.getAll();
        const providerStreams = all.filter(s => s.provider_id === providerId);
        // Smart Counting: Count unique sessions (Channel + IP + User)
        const uniqueSessions = new Set(providerStreams.map(s =>
          JSON.stringify({ c: s.channel_name, i: s.ip, u: s.user_id })
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
    if (this.redis) {
      try {
        const all = await this.getAll();
        return all.some(s => s.user_id === userId && s.ip === ip && s.channel_name === channelName && s.provider_id === providerId);
      } catch (e) {
        return false;
      }
    } else if (this.db) {
      try {
        return !!this.stmtIsActive.get(userId, ip, channelName, providerId);
      } catch (e) {
        return false;
      }
    }
    return false;
  }
}

export default new StreamManager();
