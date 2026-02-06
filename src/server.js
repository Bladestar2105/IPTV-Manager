import cluster from 'cluster';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { createClient } from 'redis';
import dotenv from 'dotenv';

import app from './app.js';
import db, { initDb } from './database/db.js';
import streamManager from './stream_manager.js';
import { startSyncScheduler, startEpgScheduler, startCleanupScheduler } from './services/schedulerService.js';
import { createDefaultAdmin } from './services/authService.js';
import { PORT } from './config/constants.js';

dotenv.config();

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Stream Manager (Redis or SQLite)
let redisClient = null;

(async () => {
  if (process.env.REDIS_URL) {
      try {
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.error('Redis Client Error', err));
        await redisClient.connect();
        streamManager.init(db, redisClient);
      } catch (e) {
        console.error('Failed to connect to Redis, falling back to SQLite:', e);
        streamManager.init(db, null);
      }
  } else {
    streamManager.init(db, null);
  }

  if (cluster.isPrimary) {
    // Init DB and Run Migrations
    initDb(true);

    // Create default admin
    await createDefaultAdmin();

    const numCPUs = os.cpus().length;
    console.log(`Primary ${process.pid} is running with ${numCPUs} CPUs`);

    let schedulerPid = null;

    for (let i = 0; i < numCPUs; i++) {
      const env = (i === 0) ? { IS_SCHEDULER: 'true' } : {};
      const worker = cluster.fork(env);
      if (i === 0) schedulerPid = worker.process.pid;
    }

    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.process.pid} died. Restarting...`);
      // Cleanup streams for this worker
      try {
        db.prepare('DELETE FROM current_streams WHERE worker_pid = ?').run(worker.process.pid);
      } catch(e) { console.error('Cleanup error:', e); }

      const isScheduler = (worker.process.pid === schedulerPid);
      const env = isScheduler ? { IS_SCHEDULER: 'true' } : {};

      const newWorker = cluster.fork(env);
      if (isScheduler) schedulerPid = newWorker.process.pid;
    });
  } else {
    // Worker Process

    // Start Schedulers if flagged
    if (process.env.IS_SCHEDULER === 'true') {
      startSyncScheduler();
      startEpgScheduler();
      startCleanupScheduler();
    }

    app.listen(PORT, () => {
      console.log(`✅ IPTV-Manager: http://localhost:${PORT} (Worker ${process.pid})`);
    });
  }
})();
