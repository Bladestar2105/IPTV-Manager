import db from '../config/database.js';
import { EPG_CACHE_DIR } from '../config/paths.js';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// Ensure cache dir exists
if (!fs.existsSync(EPG_CACHE_DIR)) fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });

let epgUpdateInterval = null;

export async function updateProviderEpg(providerId) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider || !provider.epg_url) {
    throw new Error('Provider or EPG URL not found');
  }

  console.log(`📡 Fetching Provider EPG from: ${provider.name}`);
  const response = await fetch(provider.epg_url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const epgData = await response.text();
  const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${providerId}.xml`);
  fs.writeFileSync(cacheFile, epgData, 'utf8');

  console.log(`✅ Provider EPG updated: ${provider.name} (${(epgData.length / 1024 / 1024).toFixed(2)} MB)`);
  return { success: true, size: epgData.length };
}

export async function updateEpgSource(sourceId) {
  const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('EPG source not found');

  // Mark as updating
  db.prepare('UPDATE epg_sources SET is_updating = 1 WHERE id = ?').run(sourceId);

  try {
    console.log(`📡 Fetching EPG from: ${source.name}`);
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const epgData = await response.text();
    const now = Math.floor(Date.now() / 1000);

    // Save to cache file
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${sourceId}.xml`);
    fs.writeFileSync(cacheFile, epgData, 'utf8');

    // Calculate next update time based on update_interval
    const nextUpdate = now + (source.update_interval * 3600);

    // Update last_update and next_update timestamps
    db.prepare('UPDATE epg_sources SET last_update = ?, next_update = ?, is_updating = 0 WHERE id = ?').run(now, nextUpdate, sourceId);

    console.log(`✅ EPG updated: ${source.name} (${(epgData.length / 1024 / 1024).toFixed(2)} MB), next update in ${source.update_interval}h`);
    return { success: true, size: epgData.length };
  } catch (e) {
    console.error(`❌ EPG update failed: ${source.name}`, e.message);
    db.prepare('UPDATE epg_sources SET is_updating = 0 WHERE id = ?').run(sourceId);
    throw e;
  }
}

export async function runEpgUpdateCycle() {
  try {
    const now = Math.floor(Date.now() / 1000);
    let updatedCount = 0;

    // Update Provider EPGs (every 24 hours by default)
    const providers = db.prepare(`
      SELECT * FROM providers
      WHERE epg_url IS NOT NULL
      AND TRIM(epg_url) != ''
    `).all();

    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      let needsUpdate = !fs.existsSync(cacheFile);

      if (fs.existsSync(cacheFile)) {
        const fileTime = fs.statSync(cacheFile).mtimeMs / 1000;
        needsUpdate = fileTime + (24 * 3600) < now;
      }

      if (needsUpdate) {
        try {
          await updateProviderEpg(provider.id);
          updatedCount++;
        } catch (e) {
          console.error(`❌ Failed to update Provider EPG ${provider.id}:`, e.message);
        }
      }
    }

    // Get all enabled EPG sources that need update
    const sources = db.prepare(`
      SELECT * FROM epg_sources
      WHERE enabled = 1
      AND is_updating = 0
      AND (
        next_update IS NULL
        OR next_update <= ?
      )
    `).all(now);

    if (sources.length > 0) {
      console.log(`📡 Updating ${sources.length} EPG source(s)...`);

      for (const source of sources) {
        try {
          await updateEpgSource(source.id);
          updatedCount++;
        } catch (e) {
          console.error(`❌ Failed to update EPG source ${source.id}:`, e.message);
        }
      }

      console.log(`✅ EPG update cycle completed (${updatedCount} source(s) updated)`);
    } else if (updatedCount > 0) {
      console.log(`✅ EPG update cycle completed (${updatedCount} provider EPG(s) updated)`);
    }
  } catch (e) {
    console.error('❌ EPG scheduler error:', e.message);
  }
}

export function startEpgUpdateScheduler() {
  // Check every 5 minutes
  const checkInterval = 5 * 60 * 1000;

  console.log('📅 Starting EPG update scheduler...');

  if (epgUpdateInterval) {
    clearInterval(epgUpdateInterval);
  }

  // Run immediately on startup
  setTimeout(() => runEpgUpdateCycle(), 1000);

  epgUpdateInterval = setInterval(async () => {
    await runEpgUpdateCycle();
  }, checkInterval);

  console.log('📅 EPG update scheduler started (check every 5 minutes)');
}
