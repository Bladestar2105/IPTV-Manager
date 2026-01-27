import db from '../config/database.js';
import { createXtreamClient, calculateNextSync, isAdultCategory } from '../utils/helpers.js';
import fetch from 'node-fetch';

let syncIntervals = new Map();

export async function performSync(providerId, userId, isManual = false) {
  const startTime = Math.floor(Date.now() / 1000);
  let channelsAdded = 0;
  let channelsUpdated = 0;
  let categoriesAdded = 0;
  let errorMessage = null;

  try {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) throw new Error('Provider not found');

    const config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?').get(providerId, userId);
    if (!config && !isManual) return;

    console.log(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);

    // Fetch channels from provider
    const xtream = createXtreamClient(provider);
    let channels = [];

    try {
      channels = await xtream.getChannels();
    } catch {
      try {
        channels = await xtream.getLiveStreams();
      } catch {
        const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_streams`;
        const resp = await fetch(apiUrl);
        channels = resp.ok ? await resp.json() : [];
      }
    }

    // Fetch categories from provider
    let providerCategories = [];
    try {
      const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_categories`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        providerCategories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    // Process categories and create mappings
    const categoryMap = new Map();

    // Check if this is the first sync (no existing mappings)
    const existingMappingsCount = db.prepare(`
      SELECT COUNT(*) as count FROM category_mappings
      WHERE provider_id = ? AND user_id = ?
    `).get(providerId, userId);

    const isFirstSync = existingMappingsCount.count === 0;

    for (const provCat of providerCategories) {
      const catId = Number(provCat.category_id);
      const catName = provCat.category_name;

      // Check if mapping exists
      let mapping = db.prepare(`
        SELECT * FROM category_mappings
        WHERE provider_id = ? AND user_id = ? AND provider_category_id = ?
      `).get(providerId, userId, catId);

      // Auto-create categories if:
      // 1. No mapping exists AND not first sync AND auto_add enabled
      // This means it's a NEW category from the provider
      const shouldAutoCreate = config && config.auto_add_categories && !mapping && !isFirstSync;

      if (shouldAutoCreate) {
        // Create new user category
        const isAdult = isAdultCategory(catName) ? 1 : 0;
        const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
        const newSortOrder = (maxSort?.max_sort || -1) + 1;

        const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(userId, catName, isAdult, newSortOrder);
        const newCategoryId = catInfo.lastInsertRowid;

        // Create new mapping (only for new categories)
        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(providerId, userId, catId, catName, newCategoryId);

        categoryMap.set(catId, newCategoryId);
        categoriesAdded++;
        console.log(`  ✅ Created category: ${catName} (id=${newCategoryId})`);
      } else if (!mapping && isFirstSync) {
        // First sync: Create mapping without user category (user will create/import manually)
        db.prepare(`
          INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
          VALUES (?, ?, ?, ?, NULL, 0)
        `).run(providerId, userId, catId, catName);
        console.log(`  📋 Registered category: ${catName} (no auto-create on first sync)`);
      } else if (mapping && mapping.user_category_id) {
        categoryMap.set(catId, mapping.user_category_id);
      }
    }

    // Load all existing mappings into categoryMap
    const existingMappings = db.prepare(`
      SELECT provider_category_id, user_category_id
      FROM category_mappings
      WHERE provider_id = ? AND user_id = ? AND user_category_id IS NOT NULL
    `).all(providerId, userId);

    for (const mapping of existingMappings) {
      categoryMap.set(Number(mapping.provider_category_id), mapping.user_category_id);
    }

    // Process channels
    const insertChannel = db.prepare(`
      INSERT OR IGNORE INTO provider_channels
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateChannel = db.prepare(`
      UPDATE provider_channels
      SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?
      WHERE provider_id = ? AND remote_stream_id = ?
    `);

    const checkExisting = db.prepare('SELECT id FROM provider_channels WHERE provider_id = ? AND remote_stream_id = ?');

    db.transaction(() => {
      for (const ch of (channels || [])) {
        const sid = Number(ch.stream_id || ch.id || 0);
        if (sid > 0) {
          const existing = checkExisting.get(providerId, sid);

          if (existing) {
            // Update existing channel - preserves ID and user_channels relationships
            updateChannel.run(
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || '',
              ch.epg_channel_id || '',
              providerId,
              sid
            );
            channelsUpdated++;
          } else {
            // Insert new channel
            insertChannel.run(
              providerId,
              sid,
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || '',
              'live',
              ch.epg_channel_id || ''
            );
            channelsAdded++;
          }

          // Auto-add to user categories if enabled
          if (config && config.auto_add_channels) {
            const catId = Number(ch.category_id || 0);
            const userCatId = categoryMap.get(catId);

            if (userCatId) {
              const provChannelId = existing ? existing.id : db.prepare('SELECT id FROM provider_channels WHERE provider_id = ? AND remote_stream_id = ?').get(providerId, sid).id;

              // Check if already added
              const existingUserChannel = db.prepare('SELECT id FROM user_channels WHERE user_category_id = ? AND provider_channel_id = ?').get(userCatId, provChannelId);

              if (!existingUserChannel) {
                const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(userCatId);
                const newSortOrder = (maxSort?.max_sort || -1) + 1;

                db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)').run(userCatId, provChannelId, newSortOrder);
              }
            }
          }
        }
      }
    })();

    // Update sync config
    if (config) {
      const nextSync = calculateNextSync(config.sync_interval);
      db.prepare('UPDATE sync_configs SET last_sync = ?, next_sync = ? WHERE id = ?').run(startTime, nextSync, config.id);
    }

    // Log success
    db.prepare(`
      INSERT INTO sync_logs (provider_id, user_id, sync_time, status, channels_added, channels_updated, categories_added)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, userId, startTime, 'success', channelsAdded, channelsUpdated, categoriesAdded);

    console.log(`✅ Sync completed: ${channelsAdded} added, ${channelsUpdated} updated, ${categoriesAdded} categories`);

  } catch (e) {
    errorMessage = e.message;
    console.error(`❌ Sync failed:`, e);

    // Log error
    db.prepare(`
      INSERT INTO sync_logs (provider_id, user_id, sync_time, status, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(providerId, userId, startTime, 'error', errorMessage);
  }

  return { channelsAdded, channelsUpdated, categoriesAdded, errorMessage };
}

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
