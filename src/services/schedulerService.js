import db from '../database/db.js';
import { performSync } from './syncService.js';
import { updateEpgSource, updateProviderEpg, pruneOldEpgData } from './epgService.js';
import { updateGeoIpDatabaseIfNeeded } from './geoIpUpdateService.js';
import { isSafeUrl } from '../utils/helpers.js';
import { resolveBudget } from '../utils/network.js';

// Reading a provider catalog holds the response bytes, the decoded string and
// the parsed object graph in the heap at the same time, several times the wire
// size of a list that can itself be hundreds of megabytes. The scheduler used to
// start every due config in one un-awaited loop, so configs whose next_sync
// happens to cluster — after a restart, or after a shared upstream failed them
// together — parsed their catalogs concurrently. Configs above the cap keep
// their next_sync and are simply picked up by a later tick.
const MAX_CONCURRENT_SYNCS = resolveBudget(process.env.SYNC_MAX_CONCURRENT, 2, 1, 64, 'SYNC_MAX_CONCURRENT');
// A backlog is normal for a tick or two. Saying so on every tick would be noise,
// so it is reported at most this often.
const BACKLOG_LOG_INTERVAL_MS = 900000;
let lastBacklogLogAt = 0;

let syncInterval = null;
let epgInterval = null;
const runningSyncs = new Set();
const runningEpgUpdates = new Set();

export function startSyncScheduler() {
  if (syncInterval) clearInterval(syncInterval);

  // Check every minute
  syncInterval = setInterval(async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      // Longest overdue first. Without the order the scan returns rowid order,
      // which is the same on every tick — so with the cap in place the head of
      // the list would win every time and the tail would never run at all.
      const configs = db.prepare(
        'SELECT * FROM sync_configs WHERE enabled = 1 AND next_sync <= ? ORDER BY next_sync ASC, id ASC'
      ).all(now);

      let deferred = 0;
      for (const config of configs) {
        // Already-running first: a config that is itself one of the in-flight
        // syncs is not waiting for a slot, and counting it as waiting made the
        // warning below blame the cap in exactly the steady state where the
        // constraint is sync duration instead.
        if (runningSyncs.has(config.id)) continue;
        if (runningSyncs.size >= MAX_CONCURRENT_SYNCS) { deferred++; continue; }
        runningSyncs.add(config.id);

        performSync(config.provider_id, config.user_id, { mode: 'scheduled' })
          .catch(e => console.error(`Scheduled sync error for provider ${config.provider_id}:`, e))
          .finally(() => runningSyncs.delete(config.id));
      }

      // A config held back by the cap keeps its next_sync and writes no log
      // row, so without this the provider looks healthy while never syncing.
      if (deferred > 0 && Date.now() - lastBacklogLogAt >= BACKLOG_LOG_INTERVAL_MS) {
        lastBacklogLogAt = Date.now();
        console.warn(`⏳ ${deferred} due provider sync(s) waiting: ${MAX_CONCURRENT_SYNCS} run at a time` +
          ' (SYNC_MAX_CONCURRENT). Raise it, or lengthen the sync interval, if the backlog does not drain.');
      }
    } catch (e) {
      console.error('Sync Scheduler error:', e);
    }
  }, 60000);

  console.info('📅 Sync Scheduler started');
}

export function startEpgScheduler() {
  if (epgInterval) clearInterval(epgInterval);
  const failedUpdates = new Map();

  // Check every minute
  epgInterval = setInterval(async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Custom Sources
    try {
      const sources = db.prepare('SELECT * FROM epg_sources WHERE enabled = 1 AND is_updating = 0').all();
      for (const source of sources) {
        if (source.last_update + source.update_interval <= now) {
          const updateKey = `custom:${source.id}`;
          if (runningEpgUpdates.has(updateKey)) continue;
          runningEpgUpdates.add(updateKey);
          try {
            await updateEpgSource(source.id);
          } catch (e) {
            console.error(`Scheduled EPG update failed for ${source.name}:`, e.message);
          } finally {
            runningEpgUpdates.delete(updateKey);
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
          const updateKey = `provider:${provider.id}`;
          if (runningEpgUpdates.has(updateKey)) continue;
          runningEpgUpdates.add(updateKey);
          try {
            console.debug(`🔄 Starting scheduled EPG update for provider ${provider.name}`);

            if (provider.epg_url && provider.epg_url.trim() !== '') {
              if (!(await isSafeUrl(provider.epg_url))) {
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
          } finally {
            runningEpgUpdates.delete(updateKey);
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
  let updateInProgress = false;

  // Update GeoIP database on startup, and then every week
  const updateGeoIp = async () => {
    if (updateInProgress) {
      console.info('🌍 GeoIP Auto-Update: Update already running. Skipping.');
      return;
    }

    updateInProgress = true;
    try {
      const licenseKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('geoip_license_key');
      const licenseKey = licenseKeyRow ? licenseKeyRow.value : process.env.MAXMIND_LICENSE_KEY;

      if (!licenseKey) {
         console.info('🌍 GeoIP Auto-Update: No MaxMind License Key found in settings or environment. Skipping update.');
         return;
      }

      console.info('🌍 GeoIP Auto-Update: Checking for updates...');

      const result = await updateGeoIpDatabaseIfNeeded(licenseKey);
      if (result.status === 'up_to_date') {
        console.info('🌍 GeoIP Auto-Update: Database already up to date.');
        return;
      }

      console.info('🌍 GeoIP Auto-Update: Completed successfully and reloaded in-memory cache.');
      const now = Math.floor(Date.now() / 1000);
      db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
        '127.0.0.1', 'GeoIP Auto-Update', 'Database updated successfully', now
      );
    } catch (e) {
      console.error('🌍 GeoIP Auto-Update error:', e.message);
    } finally {
      updateInProgress = false;
    }
  };

  // Run on startup
  updateGeoIp();

  // Run weekly
  setInterval(() => {
    updateGeoIp();
  }, 7 * 24 * 3600 * 1000);
  console.info('🌍 GeoIP Updater started');
}
