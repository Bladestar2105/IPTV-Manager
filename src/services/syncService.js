import { clearChannelsCache } from '../services/cacheService.js';
import { Xtream } from '@iptv/xtream-api';
import db from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { isAdultCategory, providerSourceKey } from '../utils/helpers.js';
import { parseM3uStream } from '../utils/playlistParser.js';
import { prePopulateProviderIconCache } from './logoResolver.js';

function createXtreamClient(provider) {
  let baseUrl = (provider.url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

export async function checkProviderExpiry(providerId) {
  try {
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) return null;

    const password = decrypt(provider.password);
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(password)}`;

    // Use fetch directly to get user_info
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}`, { timeout: 30000 });
    if (!resp.ok) return null;

    const data = await resp.json();
    if (data && data.user_info && data.user_info.exp_date !== undefined) {
      let expDate = data.user_info.exp_date;
      let expiry = null;

      if (expDate !== null && expDate !== 'null') {
          expiry = parseInt(expDate, 10);
          if (isNaN(expiry)) expiry = null;
      }

      db.prepare('UPDATE providers SET expiry_date = ? WHERE id = ?').run(expiry, providerId);
      console.info(`✅ Updated expiry date for provider ${provider.name}: ${expiry}`);
      return expiry;
    }
  } catch (e) {
    console.error(`Failed to check expiry for provider ${providerId}:`, e.message);
  }
  return null;
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

export async function performSync(providerId, userId, options = {}) {
  const startTime = Math.floor(Date.now() / 1000);
  let channelsAdded = 0;
  let channelsUpdated = 0;
  let categoriesAdded = 0;
  let errorMessage = null;
  let config = null;

  try {
    config = db.prepare('SELECT * FROM sync_configs WHERE provider_id = ? AND user_id = ?').get(providerId, userId);
    const isManual = options?.mode === 'manual';
    if ((!config || Number(config.enabled) !== 1) && !isManual) {
      return { channelsAdded, channelsUpdated, categoriesAdded, errorMessage };
    }

    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) throw new Error('Provider not found');
    const crossOwner = Number(provider.user_id) !== Number(userId);
    const hasPersistedGrant = Number(config?.granted_by_admin) === 1;
    const hasManualGrant = isManual && options?.allowCrossOwner === true;

    if (crossOwner && !hasPersistedGrant && !hasManualGrant) {
      const disabled = config
        ? db.prepare('UPDATE sync_configs SET enabled = 0 WHERE id = ? AND enabled = 1').run(config.id).changes
        : 0;
      db.prepare('INSERT INTO security_logs (ip, action, details, timestamp) VALUES (?, ?, ?, ?)').run(
        'scheduler',
        'cross_owner_sync_blocked',
        `Blocked unapproved cross-owner sync for provider ${providerId}; disabled ${disabled} config(s)`,
        startTime
      );
      console.warn(`Blocked unapproved cross-owner sync for provider ${providerId}; disabled ${disabled} config(s)`);
      errorMessage = 'Cross-owner sync requires explicit administrator approval';
      return { channelsAdded, channelsUpdated, categoriesAdded, errorMessage };
    }

    const assignmentGrant = crossOwner ? 1 : 0;

    // Check expiry (non-blocking or blocking? blocking is safer to ensure updated data)
    await checkProviderExpiry(providerId);

    // Decrypt password for usage
    provider.password = decrypt(provider.password);

    console.info(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);

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
             const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_live_streams`, { timeout: 60000 });
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
             const m3uResp = await fetchSafe(provider.url, { timeout: 60000 }); // Use original URL
             if (m3uResp.ok) {
                 const parsed = await parseM3uStream(m3uResp.body);
                 if (parsed.isM3u) {
                     console.debug('  📂 Detected M3U Playlist');
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
                             metadata: ch.metadata || {}, // Store parsed headers/drm (Optimization: avoid double stringify)
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
           const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_live_categories`, { timeout: 60000 });
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
       console.debug('Fetching VOD streams...');
       const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_vod_streams`, { timeout: 60000 });
       if(resp.ok) {
         const vods = await resp.json();
         console.debug(`Fetched ${Array.isArray(vods) ? vods.length : 'invalid'} VODs`);
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

       const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_vod_categories`, { timeout: 60000 });
       if(respCat.ok) {
          const cats = await respCat.json();
          if (Array.isArray(cats)) {
             cats.forEach(c => { c.category_type = 'movie'; allCategories.push(c); });
          }
       }
    } catch(e) { console.error('VOD sync error:', e); }

    // 3. Series
    try {
       const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series`, { timeout: 60000 });
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

       const respCat = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series_categories`, { timeout: 60000 });
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
      (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type, rating, rating_5based, added, plot, "cast", director, genre, releaseDate, youtube_trailer, episode_run_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateChannel = db.prepare(`
      UPDATE provider_channels
      SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?, original_sort_order = ?, tv_archive = ?, tv_archive_duration = ?, stream_type = ?, metadata = ?, mime_type = ?, rating = ?, rating_5based = ?, added = ?, plot = ?, "cast" = ?, director = ?, genre = ?, releaseDate = ?, youtube_trailer = ?, episode_run_time = ?
      WHERE provider_id = ? AND remote_stream_id = ?
    `);

    // Optimized: Pre-fetch all channels to avoid N+1 query and allow change detection
    const existingChannels = db.prepare(`
      SELECT id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id,
             original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type,
             rating, rating_5based, added, plot, "cast", director, genre, releaseDate,
             youtube_trailer, episode_run_time
      FROM provider_channels
      WHERE provider_id = ?
    `).all(providerId);

    const existingMap = new Map();
    for (const row of existingChannels) {
      existingMap.set(row.remote_stream_id, row);
    }

    // Optimization: Pre-fetch user channel assignments and sort orders to avoid N+1 queries
    const existingAssignments = new Set();
    const maxSortMap = new Map();

    // Prepare statement unconditionally to avoid potential undefined issues
    const insertUserChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order, granted_by_admin) VALUES (?, ?, ?, ?)');
    const deleteUserChannel = db.prepare('DELETE FROM user_channels WHERE user_category_id = ? AND provider_channel_id = ?');

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
      let currentSortOrder = maxSortRow?.max_sort ?? -1;

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
          console.debug(`  ✅ Created category: ${catName} (${catType}) (id=${newCategoryId})`);
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

          console.debug(`  📋 Registered category: ${catName} (${catType})`);
        }
      }

      // 2. Process Channels
      for (let i = 0; i < allChannels.length; i++) {
        const ch = allChannels[i];
        const sid = Number(ch.stream_id || ch.series_id || ch.id || 0);
        if (sid > 0) {
          const existingRow = existingMap.get(sid);
          const existingId = existingRow ? existingRow.id : undefined;
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
          const rating_5based = Number(ch.rating_5based || meta.rating_5based) || 0;
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
          // last_modified from get_series gates the per-series episode sync
          if(ch.last_modified !== undefined && ch.last_modified !== null && ch.last_modified !== '') meta.last_modified = String(ch.last_modified);

          const metaStr = JSON.stringify(meta);

          if (existingId) {
            // Optimization: Check if update is needed
            // Normalize values for comparison (DB returns numbers/nulls, inputs might be different types)
            const newName = ch.name || 'Unknown';
            const newCatId = Number(ch.category_id || 0);
            const newLogo = ch.stream_icon || ch.cover || '';
            const newEpgId = ch.epg_channel_id || '';
            const newSort = i;
            const newTvArchive = tvArchive;
            const newTvArchiveDur = tvArchiveDuration;
            const newStreamType = streamType;
            const newMetaStr = metaStr;
            const newMime = mimeType;
            const newRating = rating;
            const newRating5 = rating_5based;
            const newAdded = added;
            const newPlot = plot;
            const newCast = String(cast);
            const newDirector = String(director);
            const newGenre = String(genre);
            const newRelease = releaseDate;
            const newTrailer = youtube_trailer;
            const newRuntime = episode_run_time;

            const hasChanges =
              existingRow.name !== newName ||
              existingRow.original_category_id !== newCatId ||
              (existingRow.logo || '') !== newLogo ||
              (existingRow.epg_channel_id || '') !== newEpgId ||
              existingRow.original_sort_order !== newSort ||
              existingRow.tv_archive !== newTvArchive ||
              existingRow.tv_archive_duration !== newTvArchiveDur ||
              (existingRow.stream_type || 'live') !== newStreamType ||
              (existingRow.metadata || '{}') !== newMetaStr ||
              (existingRow.mime_type || '') !== newMime ||
              (existingRow.rating || '') !== newRating ||
              (existingRow.rating_5based || 0) !== newRating5 ||
              (existingRow.added || '') !== newAdded ||
              (existingRow.plot || '') !== newPlot ||
              (existingRow.cast || '') !== newCast ||
              (existingRow.director || '') !== newDirector ||
              (existingRow.genre || '') !== newGenre ||
              (existingRow.releaseDate || '') !== newRelease ||
              (existingRow.youtube_trailer || '') !== newTrailer ||
              (existingRow.episode_run_time || '') !== newRuntime;

            const categoryChanged = existingRow.original_category_id !== newCatId || (existingRow.stream_type || 'live') !== newStreamType;

            if (hasChanges) {
              // If the provider moved this channel to a different category or stream type,
              // remove it from the old user category (if auto_add_channels is enabled).
              // The subsequent logic will add it to the new user category if applicable.
              if (categoryChanged && config && config.auto_add_channels) {
                const oldLookupKey = `${existingRow.original_category_id}_${existingRow.stream_type || 'live'}`;
                const oldUserCatId = categoryMap.get(oldLookupKey);

                if (oldUserCatId) {
                  const assignmentKey = `${oldUserCatId}_${existingId}`;
                  if (existingAssignments.has(assignmentKey)) {
                    deleteUserChannel.run(oldUserCatId, existingId);
                    existingAssignments.delete(assignmentKey);
                    console.debug(`  🗑️ Removed moved channel "${newName}" from old user category (id=${oldUserCatId})`);
                  }
                }
              }

              // Update existing channel - preserves ID and user_channels relationships
              updateChannel.run(
                newName,
                newCatId,
                newLogo,
                newEpgId,
                newSort,
                newTvArchive,
                newTvArchiveDur,
                newStreamType,
                newMetaStr,
                newMime,
                newRating,
                newRating5,
                newAdded,
                newPlot,
                newCast,
                newDirector,
                newGenre,
                newRelease,
                newTrailer,
                newRuntime,
                providerId,
                sid
              );
              channelsUpdated++;
            }
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

                insertUserChannel.run(userCatId, provChannelId, newSortOrder, assignmentGrant);

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

    // Invalidate cache since channels might have been added/updated
    clearChannelsCache(userId);

    // Pre-populate provider icon cache for faster logo lookups
    prePopulateProviderIconCache(providerId);

    // Log success
    db.prepare(`
      INSERT INTO sync_logs (provider_id, user_id, sync_time, status, channels_added, channels_updated, categories_added)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, userId, startTime, 'success', channelsAdded, channelsUpdated, categoriesAdded);

    console.info(`✅ Sync completed: ${channelsAdded} added, ${channelsUpdated} updated, ${categoriesAdded} categories`);

    // Fetch series episodes in the background so get.php can expand series
    // into per-episode entries. Fire-and-forget: manual syncs return fast.
    const episodesEnabled = !config || config.sync_series_episodes === undefined || Number(config.sync_series_episodes) !== 0;
    if (episodesEnabled) {
      syncSeriesEpisodes(providerId).catch(err => console.error(`Episode sync failed for provider ${providerId}:`, err.message));
    }

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

// --- Series episode sync ----------------------------------------------------
// Xtream get.php playlists list every episode of every series. Episodes are
// not included in get_series, so they are fetched per series via
// get_series_info and cached in provider_series_episodes. The last_modified
// value from get_series (stored in provider_channels.metadata) gates
// refetching, so after the initial run only changed series are re-fetched.
//
// Episode data is stored per upstream panel (source_key = normalized provider
// URL), not per provider row: users pointing at the same panel with their own
// credentials share one episode catalog, so nothing is fetched or stored
// twice. Remote episode IDs are panel-global, which is what makes the shared
// catalog (and the providerId*OFFSET+episodeId playback encoding) valid.

const EPISODE_SYNC_CONCURRENCY = 3;
const EPISODE_SYNC_RETRY_AGE = 7 * 86400; // re-check series lacking last_modified weekly

const episodeSyncLocks = new Set();

export function parseSeriesInfoEpisodes(data) {
  const episodes = [];
  if (!data || !data.episodes) return episodes;
  const seasons = Array.isArray(data.episodes) ? data.episodes : Object.values(data.episodes);
  for (const seasonEps of seasons) {
    if (!Array.isArray(seasonEps)) continue;
    for (const ep of seasonEps) {
      const remoteEpisodeId = Number(ep && ep.id);
      if (!remoteEpisodeId) continue;
      episodes.push({
        remote_episode_id: remoteEpisodeId,
        season: Number(ep.season) || 0,
        episode_num: Number(ep.episode_num) || 0,
        title: ep.title ? String(ep.title) : '',
        container_extension: ep.container_extension ? String(ep.container_extension) : 'mp4',
        logo: (ep.info && (ep.info.movie_image || ep.info.cover_big)) || '',
        added: ep.added ? String(ep.added) : ''
      });
    }
  }
  return episodes;
}

export async function syncSeriesEpisodes(providerId) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return { error: 'Provider not found' };

  const sourceKey = providerSourceKey(provider.url);
  if (!sourceKey) return { error: 'Provider has no URL' };

  if (episodeSyncLocks.has(sourceKey)) {
    console.debug(`Episode sync already running for source ${sourceKey}, skipping`);
    return { skipped: true };
  }
  episodeSyncLocks.add(sourceKey);

  try {
    const password = decrypt(provider.password);
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(password)}`;

    // All provider rows pointing at the same upstream panel share the catalog
    const siblingProviderIds = db.prepare('SELECT id, url FROM providers').all()
      .filter(p => providerSourceKey(p.url) === sourceKey)
      .map(p => p.id);

    // Drop episodes/state of series that no longer exist at the upstream
    // (i.e. in no provider row of this source)
    const siblingPlaceholders = siblingProviderIds.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM provider_series_episodes WHERE source_key = ? AND series_remote_id NOT IN (
        SELECT remote_stream_id FROM provider_channels WHERE provider_id IN (${siblingPlaceholders}) AND stream_type = 'series')
    `).run(sourceKey, ...siblingProviderIds);
    db.prepare(`
      DELETE FROM provider_series_state WHERE source_key = ? AND series_remote_id NOT IN (
        SELECT remote_stream_id FROM provider_channels WHERE provider_id IN (${siblingPlaceholders}) AND stream_type = 'series')
    `).run(sourceKey, ...siblingProviderIds);

    const seriesRows = db.prepare(`
      SELECT remote_stream_id, metadata FROM provider_channels
      WHERE provider_id = ? AND stream_type = 'series'
    `).all(providerId);
    if (seriesRows.length === 0) return { synced: 0, failed: 0, total: 0 };

    const stateRows = db.prepare('SELECT series_remote_id, last_modified, synced_at FROM provider_series_state WHERE source_key = ?').all(sourceKey);
    const stateMap = new Map(stateRows.map(s => [Number(s.series_remote_id), s]));

    const nowSec = Math.floor(Date.now() / 1000);
    const queue = [];
    for (const row of seriesRows) {
      const sid = Number(row.remote_stream_id);
      if (!sid) continue;
      let lastModified = '';
      let fromM3u = false;
      try {
        const meta = JSON.parse(row.metadata || '{}');
        if (meta.last_modified !== undefined && meta.last_modified !== null) lastModified = String(meta.last_modified);
        // Entries parsed from an M3U playlist have no Xtream API behind them;
        // get_series_info would fail on every sync, so never queue them.
        if (meta.original_url) fromM3u = true;
      } catch { /* ignore malformed metadata */ }
      if (fromM3u) continue;

      const state = stateMap.get(sid);
      if (!state) {
        queue.push({ sid, lastModified });
      } else if (lastModified) {
        if ((state.last_modified || '') !== lastModified) queue.push({ sid, lastModified });
      } else if ((nowSec - (state.synced_at || 0)) >= EPISODE_SYNC_RETRY_AGE) {
        queue.push({ sid, lastModified });
      }
    }

    if (queue.length === 0) {
      console.debug(`Episode sync for provider ${provider.name}: everything up to date`);
      return { synced: 0, failed: 0, total: 0 };
    }
    console.info(`📺 Episode sync for provider ${provider.name}: ${queue.length}/${seriesRows.length} series to update`);

    const upsertEpisode = db.prepare(`
      INSERT INTO provider_series_episodes
        (source_key, series_remote_id, remote_episode_id, season, episode_num, title, container_extension, logo, added)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key, remote_episode_id) DO UPDATE SET
        series_remote_id = excluded.series_remote_id,
        season = excluded.season,
        episode_num = excluded.episode_num,
        title = excluded.title,
        container_extension = excluded.container_extension,
        logo = excluded.logo,
        added = excluded.added
    `);
    const selectExistingEpisodes = db.prepare('SELECT remote_episode_id FROM provider_series_episodes WHERE source_key = ? AND series_remote_id = ?');
    const deleteEpisode = db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ? AND remote_episode_id = ?');
    const upsertState = db.prepare(`
      INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key, series_remote_id) DO UPDATE SET
        last_modified = excluded.last_modified,
        synced_at = excluded.synced_at
    `);

    const applySeries = db.transaction((sid, lastModified, episodes) => {
      const keep = new Set();
      for (const ep of episodes) {
        upsertEpisode.run(sourceKey, sid, ep.remote_episode_id, ep.season, ep.episode_num, ep.title, ep.container_extension, ep.logo, ep.added);
        keep.add(ep.remote_episode_id);
      }
      for (const row of selectExistingEpisodes.all(sourceKey, sid)) {
        if (!keep.has(Number(row.remote_episode_id))) deleteEpisode.run(sourceKey, row.remote_episode_id);
      }
      upsertState.run(sourceKey, sid, lastModified, Math.floor(Date.now() / 1000));
    });

    let processed = 0;
    let failed = 0;
    let episodeCount = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        try {
          const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series_info&series_id=${item.sid}`, { timeout: 30000 });
          if (!resp.ok) { failed++; continue; }
          const data = await resp.json();
          // Error payloads (auth failures etc.) carry neither episodes nor info;
          // skip instead of wiping previously synced episodes.
          if (!data || typeof data !== 'object' || (!data.episodes && !data.info)) { failed++; continue; }
          const episodes = parseSeriesInfoEpisodes(data);
          applySeries(item.sid, item.lastModified, episodes);
          episodeCount += episodes.length;
          processed++;
          if (processed % 250 === 0) {
            console.info(`📺 Episode sync progress (${sourceKey}): ${processed}/${queue.length} series`);
          }
        } catch (e) {
          failed++;
          console.debug(`Episode fetch failed for series ${item.sid}: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EPISODE_SYNC_CONCURRENCY, queue.length) }, () => worker()));

    console.info(`✅ Episode sync completed for provider ${provider.name}: ${processed} series updated (${episodeCount} episodes), ${failed} failed`);
    return { synced: processed, failed, total: queue.length };
  } finally {
    episodeSyncLocks.delete(sourceKey);
  }
}
