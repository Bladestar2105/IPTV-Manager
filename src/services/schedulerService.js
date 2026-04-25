import fetch from 'node-fetch';
import { spawn } from 'child_process';
import path from 'path';
import db from '../database/db.js';
import { performSync } from './syncService.js';
import { updateEpgSource, updateProviderEpg, pruneOldEpgData } from './epgService.js';
import { isSafeUrl } from '../utils/helpers.js';

let syncInterval = null;
const runningSyncs = new Set();

export function startSyncScheduler() {
  if (syncInterval) clearInterval(syncInterval);

  // Check every minute
  syncInterval = setInterval(async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const configs = db.prepare('SELECT * FROM sync_configs WHERE enabled = 1 AND next_sync <= ?').all(now);

      for (const config of configs) {
        if (runningSyncs.has(config.id)) continue;
        runningSyncs.add(config.id);

        performSync(config.provider_id, config.user_id, false)
          .catch(e => console.error(`Scheduled sync error for provider ${config.provider_id}:`, e))
          .finally(() => runningSyncs.delete(config.id));
      }
    } catch (e) {
      console.error('Sync Scheduler error:', e);
    }
  }, 60000);

  console.info('📅 Sync Scheduler started');
}

export function startEpgScheduler() {
  const failedUpdates = new Map();

  // Check every minute
  setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Custom Sources
    try {
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
    } catch (e) { console.error('EPG Scheduler (Custom) error:', e); }

    // 2. Provider Sources
    try {
      const providers = db.prepare("SELECT * FROM providers WHERE epg_enabled = 1").all();
      for (const provider of providers) {
        const interval = provider.epg_update_interval || 86400;

        // Check if recently failed (Backoff: 15 minutes)
        const lastFail = failedUpdates.get(provider.id) || 0;
        if (lastFail && (lastFail + 900 > now)) continue;

        const lastUpdate = provider.last_epg_update || 0;

        if (lastUpdate + interval <= now) {
          try {
            console.debug(`🔄 Starting scheduled EPG update for provider ${provider.name}`);

            if (provider.epg_url && provider.epg_url.trim() !== '') {
              if (!(isSafeUrl(provider.epg_url))) {
                console.error(`Unsafe EPG URL for provider ${provider.name}`);
                failedUpdates.set(provider.id, now);
                continue;
              }
            }

            await updateProviderEpg(provider.id);
            failedUpdates.delete(provider.id);

          } catch (e) {
            console.error(`Scheduled EPG update failed for ${provider.name}:`, e.message);
            failedUpdates.set(provider.id, now);
          }
        }
      }
    } catch (e) { console.error('EPG Scheduler (Provider) error:', e); }
  }, 60000);
  console.info('📅 EPG Scheduler started');
}

export function startCleanupScheduler() {
  // Check every hour
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

      // Clean old EPG data (7 days)
      pruneOldEpgData(7);

    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }, 3600000); // Every hour
  console.info('🧹 Cleanup Scheduler started');
}

export function startGeoIpUpdater() {
  // Update GeoIP database on startup, and then every week
  const updateGeoIp = () => {
    try {
      const licenseKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('geoip_license_key');
      const licenseKey = licenseKeyRow ? licenseKeyRow.value : process.env.MAXMIND_LICENSE_KEY;

      if (!licenseKey) {
         console.info('🌍 GeoIP Auto-Update: No MaxMind License Key found in settings or environment. Skipping update.');
         return;
      }

      console.info('🌍 GeoIP Auto-Update: Starting...');

      const scriptPath = path.resolve('node_modules/geoip-lite/scripts/updatedb.js');
      const child = spawn(process.execPath, ['--max-old-space-size=4096', scriptPath, `license_key=${licenseKey}`], {
          cwd: path.resolve('node_modules/geoip-lite'),
          env: { ...process.env, LICENSE_KEY: licenseKey },
          stdio: 'inherit'
      });

      child.on('error', (err) => {
          console.error('🌍 GeoIP Auto-Update: Failed to start process:', err);
      });

      child.on('close', async (code) => {
          if (code === 0) {
              console.info('🌍 GeoIP Auto-Update: Completed successfully.');
              try {
                  const geoip = (await import('geoip-lite')).default;
                  geoip.reloadDataSync();
                  console.info('🌍 GeoIP Auto-Update: Reloaded in-memory cache.');
              } catch (e) {
                  console.error('🌍 GeoIP Auto-Update: Failed to reload cache:', e);
              }
              const now = Math.floor(Date.now() / 1000);
              db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
                  '127.0.0.1', 'GeoIP Auto-Update', 'Database updated successfully', now
              );
          } else {
              console.error(`🌍 GeoIP Auto-Update: Exited with code ${code}`);
          }
      });
    } catch (e) {
      console.error('🌍 GeoIP Auto-Update error:', e);
    }
  };

  // Run on startup
  updateGeoIp();

  // Run weekly
  setInterval(updateGeoIp, 7 * 24 * 3600 * 1000);
  console.info('🌍 GeoIP Updater started');
}
