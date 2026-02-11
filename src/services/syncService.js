import fetch from 'node-fetch';
import { Xtream } from '@iptv/xtream-api';
import db from '../database/db.js';
import { decrypt } from '../utils/crypto.js';
import { isAdultCategory } from '../utils/helpers.js';
import { parseM3uStream } from '../playlist_parser.js';

function createXtreamClient(provider) {
  let baseUrl = (provider.url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

export function calculateNextSync(interval) {
  const now = Math.floor(Date.now() / 1000);
  switch (interval) {
    case 'hourly': return now + 3600;
    case 'every_6_hours': return now + 21600;
    case 'every_12_hours': return now + 43200;
    case 'daily': return now + 86400;
    case 'weekly': return now + 604800;
    default: return now + 86400;
  }
}

export async function performSync(providerId, userId, isManual = false) {
  const startTime = Math.floor(Date.now() / 1000);
  let channelsAdded = 0;
  let channelsUpdated = 0;
  let categoriesAdded = 0;
  let errorMessage = null;
  let config = null;

  try {
    config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?').get(providerId, userId);
    if (!config && !isManual) return;

    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) throw new Error('Provider not found');

    // Decrypt password for usage
    provider.password = decrypt(provider.password);

    console.log(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);

    // Fetch Data from Provider
    const xtream = createXtreamClient(provider);
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;

    let allChannels = [];
    let allCategories = [];

    // 1. Live & M3U Fallback
    try {
       let liveChans = [];
       let m3uMode = false;

       // Try Xtream API
       try {
         liveChans = await xtream.getChannels();
       } catch {
          try {
             const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_live_streams`);
             if (resp.ok) {
                 const contentType = resp.headers.get('content-type');
                 if (contentType && contentType.includes('application/json')) {
                     liveChans = await resp.json();
                 }
             }
          } catch(e) {}
       }

       // M3U Fallback if Xtream failed or empty
       if (!Array.isArray(liveChans) || liveChans.length === 0) {
           try {
             // Try fetching as M3U
             const m3uResp = await fetch(provider.url); // Use original URL
             if (m3uResp.ok) {
                 const parsed = await parseM3uStream(m3uResp.body);
                 if (parsed.isM3u) {
                     console.log('  📂 Detected M3U Playlist');
                     m3uMode = true;

                     // Map to Xtream format
                     parsed.channels.forEach((ch, idx) => {
                         // Generate a stable integer ID from URL
                         let hash = 0;
                         for (let i = 0; i < ch.url.length; i++) {
                             hash = ((hash << 5) - hash) + ch.url.charCodeAt(i);
                             hash |= 0;
                         }
                         const streamId = Math.abs(hash);

                         liveChans.push({
                             num: idx + 1,
                             name: ch.name,
                             stream_type: ch.stream_type || 'live',
                             stream_id: streamId,
                             stream_icon: ch.logo,
                             epg_channel_id: ch.epg_id,
                             category_id: ch.category_id,
                             category_type: ch.stream_type || 'live',
                             metadata: JSON.stringify(ch.metadata || {}), // Store parsed headers/drm
                             container_extension: ch.url.includes('.mpd') ? 'mpd' : 'ts',
                             original_url: ch.url // Pass original URL for proxying later?
                         });
                     });

                     parsed.categories.forEach(cat => {
                        allCategories.push({
                            category_id: cat.category_id,
                            category_name: cat.category_name,
                            category_type: cat.category_type
                        });
                     });
                 }
             }
           } catch (e) { console.error('M3U fallback error:', e.message); }
       }

       // Normalize
       if (Array.isArray(liveChans)) {
         liveChans.forEach(c => {
           if (!m3uMode) {
               c.stream_type = 'live';
               c.category_type = 'live';
           }
           allChannels.push(c);
         });
       }

       if (!m3uMode) {
           const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_live_categories`);
           if(respCat.ok) {
              const cats = await respCat.json();
              if (Array.isArray(cats)) {
                cats.forEach(c => { c.category_type = 'live'; allCategories.push(c); });
              }
           }
       }
    } catch(e) { console.error('Live sync error:', e); }

    // 2. Movies (VOD)
    try {
       console.log('Fetching VOD streams...');
       const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_vod_streams`);
       if(resp.ok) {
         const vods = await resp.json();
         console.log(`Fetched ${Array.isArray(vods) ? vods.length : 'invalid'} VODs`);
         if (Array.isArray(vods)) {
            vods.forEach(c => {
                c.stream_type = 'movie';
                c.category_type = 'movie';
                allChannels.push(c);
            });
         }
       } else {
         console.error(`VOD fetch failed: ${resp.status}`);
       }

       const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_vod_categories`);
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
             cats.forEach(c => { c.category_type = 'movie'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('VOD sync error:', e); }

    // 3. Series
    try {
       const resp = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_series`);
       if(resp.ok) {
         const series = await resp.json();
         if (Array.isArray(series)) {
            series.forEach(c => {
                c.stream_type = 'series';
                c.category_type = 'series';
                // Map series fields to common format
                c.stream_id = c.series_id;
                c.stream_icon = c.cover;
                allChannels.push(c);
            });
         }
       }

       const respCat = await fetch(`${baseUrl}/player_api.php?${authParams}&action=get_series_categories`);
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
             cats.forEach(c => { c.category_type = 'series'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('Series sync error:', e); }

    // Process categories and create mappings
    const categoryMap = new Map(); // Map<String, Int> -> "catId_type" -> userCatId

    // Performance Optimization: Pre-fetch all mappings to avoid N+1 queries
    const allMappings = db.prepare(`
      SELECT * FROM category_mappings
      WHERE provider_id = ? AND user_id = ?
    `).all(providerId, userId);

    const isFirstSync = allMappings.length === 0;

    // Create lookup map and populate initial categoryMap
    const mappingLookup = new Map(); // Key: "catId_type"
    for (const m of allMappings) {
      const key = `${m.provider_category_id}_${m.category_type || 'live'}`;
      mappingLookup.set(key, m);
      if (m.user_category_id) {
        categoryMap.set(key, m.user_category_id);
      }
    }

    // Prepare channel statements
    const insertChannel = db.prepare(`
      INSERT OR IGNORE INTO provider_channels
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type, rating, rating_5based, added, plot, cast, director, genre, releaseDate, youtube_trailer, episode_run_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateChannel = db.prepare(`
      UPDATE provider_channels
      SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?, original_sort_order = ?, tv_archive = ?, tv_archive_duration = ?, stream_type = ?, metadata = ?, mime_type = ?, rating = ?, rating_5based = ?, added = ?, plot = ?, cast = ?, director = ?, genre = ?, releaseDate = ?, youtube_trailer = ?, episode_run_time = ?
      WHERE provider_id = ? AND remote_stream_id = ?
    `);

    // Optimized: Pre-fetch all channels to avoid N+1 query
    const existingChannels = db.prepare('SELECT remote_stream_id, id FROM provider_channels WHERE provider_id = ?').all(providerId);
    const existingMap = new Map();
    for (const row of existingChannels) {
      existingMap.set(row.remote_stream_id, row.id);
    }

    // Optimization: Pre-fetch user channel assignments and sort orders to avoid N+1 queries
    const existingAssignments = new Set();
    const maxSortMap = new Map();

    // Prepare statement unconditionally to avoid potential undefined issues
    const insertUserChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

    if (config && config.auto_add_channels) {
      const existingAssignmentsRows = db.prepare(`
        SELECT uc.user_category_id, uc.provider_channel_id
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE pc.provider_id = ?
      `).all(providerId);

      for (const r of existingAssignmentsRows) {
        existingAssignments.add(`${r.user_category_id}_${r.provider_channel_id}`);
      }

      const sortRows = db.prepare(`
        SELECT user_category_id, MAX(sort_order) as max_sort
        FROM user_channels
        WHERE user_category_id IN (SELECT id FROM user_categories WHERE user_id = ?)
        GROUP BY user_category_id
      `).all(userId);

      for (const r of sortRows) {
        maxSortMap.set(r.user_category_id, r.max_sort);
      }
    }

    const insertUserCategory = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)');
    const insertCategoryMapping = db.prepare(`
      INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);

    // Execute all DB operations in a single transaction
    db.transaction(() => {
      // Pre-calculate max sort order for optimization
      const maxSortRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
      let currentSortOrder = maxSortRow?.max_sort || -1;

      // 1. Process Categories
      for (const provCat of allCategories) {
        const catId = Number(provCat.category_id);
        const catName = provCat.category_name;
        const catType = provCat.category_type || 'live';
        const lookupKey = `${catId}_${catType}`;

        // Check if mapping exists using lookup
        let mapping = mappingLookup.get(lookupKey);

        // Auto-create categories if:
        // 1. No mapping exists AND not first sync AND auto_add enabled
        // This means it's a NEW category from the provider
        const shouldAutoCreate = config && config.auto_add_categories && !mapping && !isFirstSync;

        if (shouldAutoCreate) {
          // Create new user category
          const isAdult = isAdultCategory(catName) ? 1 : 0;
          currentSortOrder++;
          const newSortOrder = currentSortOrder;

          const catInfo = insertUserCategory.run(userId, catName, isAdult, newSortOrder, catType);
          const newCategoryId = catInfo.lastInsertRowid;

          // Create new mapping (only for new categories)
          insertCategoryMapping.run(providerId, userId, catId, catName, newCategoryId, catType);

          categoryMap.set(lookupKey, newCategoryId);

          // Update lookup to prevent duplicates in current run
          mappingLookup.set(lookupKey, {
            provider_id: providerId,
            user_id: userId,
            provider_category_id: catId,
            provider_category_name: catName,
            user_category_id: newCategoryId,
            auto_created: 1,
            category_type: catType
          });

          categoriesAdded++;
          console.log(`  ✅ Created category: ${catName} (${catType}) (id=${newCategoryId})`);
        } else if (!mapping && isFirstSync) {
          // First sync: Create mapping without user category
          db.prepare(`
            INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
            VALUES (?, ?, ?, ?, NULL, 0, ?)
          `).run(providerId, userId, catId, catName, catType);

          // Update lookup to prevent duplicates in current run
          mappingLookup.set(lookupKey, {
            provider_id: providerId,
            user_id: userId,
            provider_category_id: catId,
            provider_category_name: catName,
            user_category_id: null,
            auto_created: 0,
            category_type: catType
          });

          console.log(`  📋 Registered category: ${catName} (${catType})`);
        }
      }

      // 2. Process Channels
      for (let i = 0; i < allChannels.length; i++) {
        const ch = allChannels[i];
        const sid = Number(ch.stream_id || ch.series_id || ch.id || 0);
        if (sid > 0) {
          const existingId = existingMap.get(sid);
          let provChannelId;

          const tvArchive = Number(ch.tv_archive) === 1 ? 1 : 0;
          const tvArchiveDuration = Number(ch.tv_archive_duration) || 0;
          const streamType = ch.stream_type || 'live';
          const mimeType = ch.container_extension || '';

          // Construct metadata
          let meta = {};
          // If we already have metadata (from M3U parsing), parse it first
          if (ch.metadata) {
              try {
                  const existing = typeof ch.metadata === 'string' ? JSON.parse(ch.metadata) : ch.metadata;
                  meta = { ...existing };
              } catch(e) {}
          }

          // Extract values for columns (prioritize direct fields, fall back to metadata)
          const plot = ch.plot || meta.plot || '';
          const cast = ch.cast || meta.cast || '';
          const director = ch.director || meta.director || '';
          const genre = ch.genre || meta.genre || '';
          const releaseDate = ch.releaseDate || meta.releaseDate || '';
          const rating = ch.rating || meta.rating || '';
          const rating_5based = ch.rating_5based || meta.rating_5based || 0;
          const youtube_trailer = ch.youtube_trailer || meta.youtube_trailer || '';
          const episode_run_time = ch.episode_run_time || meta.episode_run_time || '';
          const added = ch.added || meta.added || '';

          // Clean up metadata to avoid duplication
          delete meta.plot;
          delete meta.cast;
          delete meta.director;
          delete meta.genre;
          delete meta.rating;
          delete meta.rating_5based;
          delete meta.added;
          delete meta.releaseDate;
          delete meta.youtube_trailer;
          delete meta.episode_run_time;

          if(ch.backdrop_path) meta.backdrop_path = ch.backdrop_path;
          if(ch.original_url) meta.original_url = ch.original_url; // Store original URL for M3U streams

          const metaStr = JSON.stringify(meta);

          if (existingId) {
            // Update existing channel - preserves ID and user_channels relationships
            updateChannel.run(
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || ch.cover || '',
              ch.epg_channel_id || '',
              i, // original_sort_order
              tvArchive,
              tvArchiveDuration,
              streamType,
              metaStr,
              mimeType,
              rating,
              rating_5based,
              added,
              plot,
              String(cast),
              String(director),
              String(genre),
              releaseDate,
              youtube_trailer,
              episode_run_time,
              providerId,
              sid
            );
            channelsUpdated++;
            provChannelId = existingId;
          } else {
            // Insert new channel
            const info = insertChannel.run(
              providerId,
              sid,
              ch.name || 'Unknown',
              Number(ch.category_id || 0),
              ch.stream_icon || ch.cover || '',
              streamType,
              ch.epg_channel_id || '',
              i, // original_sort_order
              tvArchive,
              tvArchiveDuration,
              metaStr,
              mimeType,
              rating,
              rating_5based,
              added,
              plot,
              String(cast),
              String(director),
              String(genre),
              releaseDate,
              youtube_trailer,
              episode_run_time
            );
            channelsAdded++;
            provChannelId = info.lastInsertRowid;
          }

          // Auto-add to user categories if enabled
          if (config && config.auto_add_channels) {
            const catId = Number(ch.category_id || 0);
            const catType = ch.category_type || 'live';
            const lookupKey = `${catId}_${catType}`;

            const userCatId = categoryMap.get(lookupKey);

            if (userCatId) {
              // Check if already added (Optimized in-memory check)
              const assignmentKey = `${userCatId}_${provChannelId}`;

              if (!existingAssignments.has(assignmentKey)) {
                // Optimized sort order calculation
                let currentMax = maxSortMap.get(userCatId);
                if (currentMax === undefined) currentMax = -1;
                const newSortOrder = currentMax + 1;

                insertUserChannel.run(userCatId, provChannelId, newSortOrder);

                // Update in-memory state
                existingAssignments.add(assignmentKey);
                maxSortMap.set(userCatId, newSortOrder);
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

    // Update next_sync even on failure to respect interval
    if (config) {
      const nextSync = calculateNextSync(config.sync_interval);
      db.prepare('UPDATE sync_configs SET next_sync = ? WHERE id = ?').run(nextSync, config.id);
    }
  }

  return { channelsAdded, channelsUpdated, categoriesAdded, errorMessage };
}
