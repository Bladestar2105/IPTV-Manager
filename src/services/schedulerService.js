import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import db from '../database/db.js';
import { EPG_CACHE_DIR } from '../config/constants.js';
import { performSync } from './syncService.js';
import { updateEpgSource, generateConsolidatedEpg } from './epgService.js';
import { isSafeUrl } from '../utils/helpers.js';

let syncIntervals = new Map();

export function startSyncScheduler() {
  // Clear existing intervals
  syncIntervals.forEach(interval => clearInterval(interval));
  syncIntervals.clear();

  // Load all enabled sync configs
  const configs = db.prepare('SELECT * FROM sync_configs WHERE enabled = 1').all();

  for (const config of configs) {
    const checkInterval = 60000; // Check every minute

    const interval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      const currentConfig = db.prepare('SELECT * FROM sync_configs WHERE id = ?').get(config.id);

      if (currentConfig && currentConfig.enabled && currentConfig.next_sync <= now) {
        await performSync(currentConfig.provider_id, currentConfig.user_id, false);
      }
    }, checkInterval);

    syncIntervals.set(config.id, interval);
    console.log(`📅 Scheduled sync for provider ${config.provider_id} (${config.sync_interval})`);
  }
}

export function startEpgScheduler() {
  const failedUpdates = new Map();

  // Check every minute
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Custom Sources
    const sources = db.prepare('SELECT * FROM epg_sources WHERE enabled = 1 AND is_updating = 0').all();
    for (const source of sources) {
      if (source.last_update + source.update_interval <= now) {
        try {
          await updateEpgSource(source.id);
        } catch (e) {
          console.error(`Scheduled EPG update failed for ${source.name}:`, e.message);
        }
      }
    }

    // 2. Provider Sources
    const providers = db.prepare("SELECT * FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != '' AND epg_enabled = 1").all();
    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      let lastUpdate = 0;
      if (fs.existsSync(cacheFile)) {
        const stats = fs.statSync(cacheFile);
        lastUpdate = Math.floor(stats.mtimeMs / 1000);
      }

      const interval = provider.epg_update_interval || 86400;

      // Check if recently failed (Backoff: 15 minutes)
      const lastFail = failedUpdates.get(provider.id) || 0;
      if (lastFail && (lastFail + 900 > now)) continue;

      if (lastUpdate + interval <= now) {
        try {
          console.log(`🔄 Starting scheduled EPG update for provider ${provider.name}`);

          if (!(await isSafeUrl(provider.epg_url))) {
             console.error(`Unsafe EPG URL for provider ${provider.name}`);
             failedUpdates.set(provider.id, now);
             continue;
          }

          const response = await fetch(provider.epg_url);
          if (response.ok) {
            const epgData = await response.text();
            await fs.promises.writeFile(cacheFile, epgData, 'utf8');
            console.log(`✅ Scheduled EPG update success: ${provider.name}`);
            failedUpdates.delete(provider.id);
            await generateConsolidatedEpg();
          } else {
            console.error(`Scheduled EPG update HTTP error ${response.status} for ${provider.name}`);
            failedUpdates.set(provider.id, now);
          }
        } catch (e) {
          console.error(`Scheduled EPG update failed for ${provider.name}:`, e.message);
          failedUpdates.set(provider.id, now);
        }
      }
    }
  }, 60000);
  console.log('📅 EPG Scheduler started');
}

export function startCleanupScheduler() {
  setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000);
      // Clean old client logs (7 days)
      const retention = 7 * 86400;
      db.prepare('DELETE FROM client_logs WHERE timestamp < ?').run(now - retention);
      db.prepare('DELETE FROM security_logs WHERE timestamp < ?').run(now - retention);
      db.prepare('DELETE FROM blocked_ips WHERE expires_at < ?').run(now);
      // Clean expired shares
      db.prepare('DELETE FROM shared_links WHERE end_time IS NOT NULL AND end_time < ?').run(now);
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }, 3600000); // Every hour
}
