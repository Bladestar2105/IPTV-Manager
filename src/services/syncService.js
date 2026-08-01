import { clearChannelsCache } from '../services/cacheService.js';
import db from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { isAdultCategory } from '../utils/helpers.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { prePopulateProviderIconCache } from './logoResolver.js';
import { isTrustedMappingAssignment } from './userChannelAssignmentService.js';
import { createXtreamClient, fetchProviderCatalog } from './providerCatalogSyncService.js';

/**
 * Delete one provider channel without violating the dependent foreign keys.
 * The caller owns the surrounding transaction.
 */
export function deleteProviderChannelCascade(database, providerId, providerChannelId) {
  const channel = database.prepare(`
    SELECT id
    FROM provider_channels
    WHERE id = ? AND provider_id = ?
  `).get(providerChannelId, providerId);
  if (!channel) return 0;

  database.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id = ?').run(channel.id);
  database.prepare('DELETE FROM stream_stats WHERE channel_id = ?').run(channel.id);
  database.prepare('DELETE FROM user_channels WHERE provider_channel_id = ?').run(channel.id);

  const deleted = database.prepare(
    'DELETE FROM provider_channels WHERE id = ? AND provider_id = ?'
  ).run(channel.id, providerId).changes;
  if (deleted !== 1) {
    throw new Error(`Provider channel cleanup removed ${deleted} rows instead of one`);
  }
  return deleted;
}

export function selectStaleProviderChannels(
  existingChannels,
  seenRemoteIdsByType,
  completeStreamTypes,
  currentTypeByRemoteId = new Map()
) {
  const stale = [];
  for (const streamType of completeStreamTypes) {
    const seenIds = seenRemoteIdsByType.get(streamType) || new Set();
    for (const row of existingChannels) {
      const rowType = row.stream_type || 'live';
      const remoteId = Number(row.remote_stream_id);
      if (rowType !== streamType || seenIds.has(remoteId)) continue;
      // A provider may reuse a stream id while changing its stream type. The
      // row is updated in-place; do not delete the newly retargeted channel.
      const currentType = currentTypeByRemoteId.get(remoteId);
      if (currentType && currentType !== streamType) continue;
      stale.push(row);
    }
  }
  return stale;
}

function updateProviderSyncState(database, providerId, streamType, snapshotCount, localCount, timestamp) {
  const previous = database.prepare(`
    SELECT empty_snapshot_count, last_nonempty_count
    FROM provider_sync_state
    WHERE provider_id = ? AND stream_type = ?
  `).get(providerId, streamType);

  let emptySnapshotCount = Number(previous?.empty_snapshot_count) || 0;
  let lastNonemptyCount = Number(previous?.last_nonempty_count) || 0;
  let allowCleanup = false;

  if (snapshotCount > 0) {
    emptySnapshotCount = 0;
    lastNonemptyCount = snapshotCount;
    allowCleanup = true;
  } else if (localCount === 0) {
    // An empty catalog is valid when there is nothing local to destroy.
    emptySnapshotCount = 0;
    allowCleanup = true;
  } else {
    emptySnapshotCount += 1;
    allowCleanup = emptySnapshotCount >= 2;
    if (!allowCleanup) {
      console.warn(
        `Preserving ${localCount} ${streamType} provider channel(s) after one empty snapshot for provider ${providerId}`
      );
    }
  }

  database.prepare(`
    INSERT INTO provider_sync_state
      (provider_id, stream_type, empty_snapshot_count, last_nonempty_count, last_snapshot_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, stream_type) DO UPDATE SET
      empty_snapshot_count = excluded.empty_snapshot_count,
      last_nonempty_count = excluded.last_nonempty_count,
      last_snapshot_at = excluded.last_snapshot_at
  `).run(providerId, streamType, emptySnapshotCount, lastNonemptyCount, timestamp);

  return allowCleanup;
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
    const restoreRevokedAssignments = crossOwner && (
      options?.restoreRevokedAssignments === true ||
      (!isManual && hasPersistedGrant)
    );

    // Check expiry (non-blocking or blocking? blocking is safer to ensure updated data)
    await checkProviderExpiry(providerId);

    // Decrypt password for usage
    provider.password = decrypt(provider.password);

    console.info(`🔄 Starting sync for provider ${provider.name} (user ${userId})`);

    // Fetch and normalize the provider catalog before applying local mappings.
    const xtream = createXtreamClient(provider);
    const { allChannels, allCategories, completeStreamTypes, snapshotStates } =
      await fetchProviderCatalog(provider, xtream);

    // Process categories and create mappings
    // Performance Optimization: Pre-fetch all mappings to avoid N+1 queries
    const allMappings = db.prepare(`
      SELECT cm.*,
             cm.user_category_id AS mapping_user_category_id,
             uc.user_id AS target_user_id,
             COALESCE(uc.type, 'live') AS target_category_type
      FROM category_mappings cm
      LEFT JOIN user_categories uc ON uc.id = cm.user_category_id
      WHERE cm.provider_id = ? AND cm.user_id = ?
    `).all(providerId, userId);

    const isFirstSync = allMappings.length === 0;

    // Create lookup map
    const mappingLookup = new Map(); // Key: "catId_type"
    for (const m of allMappings) {
      const key = `${m.provider_category_id}_${m.category_type || 'live'}`;
      const mappingType = m.category_type || 'live';
      const targetId = Number(m.mapping_user_category_id) || 0;
      const targetValid = !targetId || (
        Number(m.target_user_id) === Number(m.user_id) &&
        (m.target_category_type || 'live') === mappingType
      );
      mappingLookup.set(key, {
        ...m,
        user_category_id: targetValid && targetId ? targetId : null,
        target_valid: targetValid
      });
    }
    const invalidMappingCount = allMappings.filter(m => {
      const targetId = Number(m.mapping_user_category_id) || 0;
      return targetId > 0 && (
        Number(m.target_user_id) !== Number(m.user_id) ||
        (m.target_category_type || 'live') !== (m.category_type || 'live')
      );
    }).length;
    if (invalidMappingCount > 0) {
      console.warn(`Ignored ${invalidMappingCount} invalid category mapping target(s) for provider ${providerId}`);
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
      ORDER BY COALESCE(stream_type, 'live'), id
    `).all(providerId);

    const existingMap = new Map();
    for (const row of existingChannels) {
      existingMap.set(Number(row.remote_stream_id), row);
    }

    // Optimization: Pre-fetch user channel assignments and sort orders to avoid N+1 queries
    const existingAssignments = new Map();
    const maxSortMap = new Map();

    // Prepare statement unconditionally to avoid potential undefined issues
    const insertUserChannel = db.prepare(`
      INSERT INTO user_channels
        (user_category_id, provider_channel_id, sort_order, assignment_origin, mapping_id, granted_by_admin, authorization_revoked)
      VALUES (?, ?, ?, 'mapping', ?, ?, 0)
      ON CONFLICT DO NOTHING
    `);
    const authorizeExistingAssignment = db.prepare(`
      UPDATE user_channels
      SET granted_by_admin = ?, authorization_revoked = 0
      WHERE id = ?
    `);
    const updateAssignmentMapping = db.prepare(`
      UPDATE user_channels
      SET mapping_id = ?, assignment_origin = 'mapping'
      WHERE id = ? AND assignment_origin = 'mapping'
    `);
    const deleteMappedAssignment = db.prepare(`
      DELETE FROM user_channels
      WHERE id = ? AND mapping_id = ? AND assignment_origin = 'mapping'
    `);

    if (config && config.auto_add_channels) {
      const existingAssignmentsRows = db.prepare(`
        SELECT uc.id, uc.user_category_id, uc.provider_channel_id,
               uc.mapping_id, uc.assignment_origin, uc.granted_by_admin, uc.authorization_revoked
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE pc.provider_id = ?
      `).all(providerId);

      for (const r of existingAssignmentsRows) {
        existingAssignments.set(`${r.user_category_id}_${r.provider_channel_id}`, r);
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

    const getMappedTargets = (categoryId, categoryType) => {
      const keys = [`${categoryId}_${categoryType}`];
      if (categoryType === 'live') keys.push(`${categoryId}_radio`);
      return keys.map(key => ({ key, mapping: mappingLookup.get(key) })).filter(({ key, mapping }) => {
        if (!mapping?.user_category_id || !mapping.id || mapping.target_valid === false) return false;
        const expectedType = key.endsWith('_radio') ? 'radio' : categoryType;
        return (mapping.category_type || 'live') === expectedType;
      }).map(({ mapping }) => mapping);
    };
    const seenRemoteIdsByType = new Map();
    const currentTypeByRemoteId = new Map();
    for (const channel of allChannels) {
      const remoteId = Number(channel.stream_id || channel.series_id || channel.id || 0);
      if (remoteId > 0) currentTypeByRemoteId.set(remoteId, channel.stream_type || 'live');
    }

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
          const mappingInfo = insertCategoryMapping.run(providerId, userId, catId, catName, newCategoryId, catType);

          // Update lookup to prevent duplicates in current run
          mappingLookup.set(lookupKey, {
            provider_id: providerId,
            user_id: userId,
            provider_category_id: catId,
            provider_category_name: catName,
            user_category_id: newCategoryId,
            id: Number(mappingInfo.lastInsertRowid),
            auto_created: 1,
            category_type: catType
          });

          categoriesAdded++;
          console.debug(`  ✅ Created category: ${catName} (${catType}) (id=${newCategoryId})`);
        } else if (!mapping && isFirstSync) {
          // First sync: Create mapping without user category
          const mappingInfo = db.prepare(`
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
            id: Number(mappingInfo.lastInsertRowid),
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
          const catId = Number(ch.category_id || 0);
          const catType = ch.category_type || 'live';
          const mappingTargets = getMappedTargets(catId, catType);
          if (!seenRemoteIdsByType.has(streamType)) seenRemoteIdsByType.set(streamType, new Set());
          seenRemoteIdsByType.get(streamType).add(sid);
          const mimeType = normalizeContainerExtension(
            ch.container_extension,
            streamType === 'live' ? 'ts' : 'mp4'
          );

          // Construct metadata
          let meta = {};
          // If we already have metadata (from M3U parsing), parse it first
          if (ch.metadata) {
              try {
                  const existing = typeof ch.metadata === 'string' ? JSON.parse(ch.metadata) : ch.metadata;
                  meta = { ...existing };
              } catch {}
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
                const oldCategoryId = Number(existingRow.original_category_id || 0);
                const oldCategoryType = existingRow.stream_type || 'live';
                const oldKeys = [`${oldCategoryId}_${oldCategoryType}`];
                if (oldCategoryType === 'live') oldKeys.push(`${oldCategoryId}_radio`);
                const oldMappingIds = new Set(oldKeys
                  .map(key => mappingLookup.get(key)?.id)
                  .filter(Boolean)
                  .map(Number));

                for (const [assignmentKey, assignment] of existingAssignments) {
                  if (Number(assignment.provider_channel_id) !== Number(existingId) ||
                      !oldMappingIds.has(Number(assignment.mapping_id)) ||
                      !isTrustedMappingAssignment(assignment, assignment.mapping_id)) continue;
                  deleteMappedAssignment.run(assignment.id, assignment.mapping_id);
                  existingAssignments.delete(assignmentKey);
                  console.debug(`  🗑️ Removed mapped assignment for moved channel "${newName}"`);
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
            for (const mapping of mappingTargets) {
              const userCatId = Number(mapping.user_category_id);
              const mappingId = Number(mapping.id);
              // Check if already added (Optimized in-memory check)
              const assignmentKey = `${userCatId}_${provChannelId}`;

              const existingAssignment = existingAssignments.get(assignmentKey);
              if (!existingAssignment) {
                // Optimized sort order calculation
                let currentMax = maxSortMap.get(userCatId);
                if (currentMax === undefined) currentMax = -1;
                const newSortOrder = currentMax + 1;

                const assignmentInfo = insertUserChannel.run(userCatId, provChannelId, newSortOrder, mappingId, assignmentGrant);
                const resolvedAssignment = db.prepare(`
                  SELECT id, user_category_id, provider_channel_id, mapping_id,
                         assignment_origin, granted_by_admin, authorization_revoked
                  FROM user_channels
                  WHERE user_category_id = ? AND provider_channel_id = ?
                `).get(userCatId, provChannelId);
                const assignmentId = Number(resolvedAssignment?.id || 0);
                if (!assignmentId) throw new Error('Unable to resolve synchronized user-channel assignment');

                // Update in-memory state
                existingAssignments.set(assignmentKey, resolvedAssignment);
                if (assignmentInfo.changes === 1) maxSortMap.set(userCatId, newSortOrder);
              } else {
                if (isTrustedMappingAssignment(existingAssignment, existingAssignment.mapping_id) &&
                    Number(existingAssignment.mapping_id) !== mappingId) {
                  updateAssignmentMapping.run(mappingId, existingAssignment.id);
                  existingAssignment.mapping_id = mappingId;
                }
                if (!crossOwner) {
                  authorizeExistingAssignment.run(0, existingAssignment.id);
                } else if (Number(existingAssignment.granted_by_admin) === 1 || restoreRevokedAssignments) {
                  authorizeExistingAssignment.run(1, existingAssignment.id);
                }
              }
            }
          }
        }
      }

      const cleanupTypes = new Set();
      for (const streamType of completeStreamTypes) {
        const snapshot = snapshotStates.get(streamType);
        if (!snapshot) continue;
        const localCount = existingChannels.reduce(
          (count, row) => count + ((row.stream_type || 'live') === streamType ? 1 : 0),
          0
        );
        if (updateProviderSyncState(db, providerId, streamType, snapshot.count, localCount, startTime)) {
          cleanupTypes.add(streamType);
        }
      }

      // Calculate stale rows from the already loaded catalog and in-memory
      // Sets. This avoids SQLite's bound-variable limit for large providers.
      const staleRows = selectStaleProviderChannels(
        existingChannels,
        seenRemoteIdsByType,
        cleanupTypes,
        currentTypeByRemoteId
      );
      for (const stale of staleRows) {
        deleteProviderChannelCascade(db, providerId, stale.id);
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

import { parseSeriesInfoEpisodes, syncSeriesEpisode, syncSeriesEpisodes } from './seriesSyncService.js';

export { parseSeriesInfoEpisodes, syncSeriesEpisode, syncSeriesEpisodes };
