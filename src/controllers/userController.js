import { clearChannelsCache } from '../services/cacheService.js';
import { invalidateUserTokens, invalidateUserCache } from '../services/authService.js';
import streamManager from '../services/streamManager.js';
import db from '../database/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { BCRYPT_ROUNDS } from '../config/constants.js';
import { providerSourceKey } from '../utils/helpers.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import {
  normalizeAssignmentOrigin,
  upsertMergedUserChannelAssignment
} from '../services/userChannelAssignmentService.js';

const getClonedProviderChannelName = (channel) => {
  if (typeof channel.name === 'string' && channel.name.trim()) return channel.name;
  const fallbackId = channel.remote_stream_id ?? channel.id ?? 'unknown';
  return `Channel ${fallbackId}`;
};

export const getUsers = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    // ⚡ Bolt: Replace .all().map() with .iterate() to eliminate intermediate V8 array allocation
    // 🎯 Why: Loading a massive list of users into memory, only to map it into another array, causes double memory allocation and GC pressure.
    // 📊 Impact: Lowers peak memory usage and garbage collection overhead, especially on instances with many users.
    const stmt = db.prepare('SELECT id, username, password, plain_password, is_active, webui_access, hdhr_enabled, hdhr_token, max_connections, expiry_date, allowed_countries, notes FROM users ORDER BY id');
    const result = [];

    for (const u of stmt.iterate()) {
        let plainPassword = null;
        if (req.user.is_admin && u.plain_password) {
            try {
                plainPassword = decrypt(u.plain_password);
            } catch (err) {
                // ignore
            }
        }

        result.push({
            id: u.id,
            username: u.username,
            plain_password: plainPassword || '********',
            is_active: u.is_active,
            webui_access: u.webui_access,
            hdhr_enabled: u.hdhr_enabled,
            hdhr_token: u.hdhr_token,
            max_connections: u.max_connections || 0,
            expiry_date: u.expiry_date,
            allowed_countries: u.allowed_countries,
            notes: u.notes
        });
    }

    res.json(result);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { username, password, webui_access, hdhr_enabled, copy_from_user_id, max_connections, expiry_date, allowed_countries, notes } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Username and password are required'
      });
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({
            error: 'invalid_input_type',
            message: 'Username and password must be strings'
        });
    }

    const u = username.trim();
    const p = password.trim();

    // Validate username
    if (u.length < 3 || u.length > 50) {
      return res.status(400).json({
        error: 'invalid_username_length',
        message: 'Username must be 3-50 characters'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(u)) {
      return res.status(400).json({
        error: 'invalid_username_format',
        message: 'Username can only contain letters, numbers, and underscores'
      });
    }

    // Check for duplicate username (users)
    const duplicate = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
    if (duplicate) {
        return res.status(400).json({
            error: 'username_taken',
            message: 'Username is already taken'
        });
    }

    // Check for duplicate username (admin_users)
    const duplicateAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(u);
    if (duplicateAdmin) {
        return res.status(400).json({
            error: 'username_taken',
            message: 'Username is reserved by an administrator'
        });
    }

    // Validate password
    if (p.length < 8) {
      return res.status(400).json({
        error: 'password_too_short',
        message: 'Password must be at least 8 characters'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);
    const encryptedPlainPassword = encrypt(p);

    if (notes && notes.length > 50) {
      return res.status(400).json({
        error: 'notes_too_long',
        message: 'Notes must be up to 50 characters'
      });
    }

    let hdhrToken = null;
    const isHdhrEnabled = hdhr_enabled ? 1 : 0;
    if (isHdhrEnabled) {
        hdhrToken = crypto.randomBytes(16).toString('hex');
    }

    // Use transaction for atomic creation + copying
    db.transaction(() => {
        // Insert user
        const info = db.prepare('INSERT INTO users (username, password, plain_password, webui_access, hdhr_enabled, hdhr_token, max_connections, expiry_date, allowed_countries, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            u,
            hashedPassword,
            encryptedPlainPassword,
            webui_access !== undefined ? (webui_access ? 1 : 0) : 1,
            isHdhrEnabled,
            hdhrToken,
            (max_connections !== undefined && max_connections !== '') ? Number(max_connections) : 0,
            expiry_date || null,
            (allowed_countries && allowed_countries !== 'null' && allowed_countries !== 'undefined') ? allowed_countries : null,
            notes ? notes.trim() : null
        );
        const newUserId = info.lastInsertRowid;

        // Copy logic
        if (copy_from_user_id) {
            const sourceUserId = Number(copy_from_user_id);
            const sourceUser = db.prepare('SELECT id FROM users WHERE id = ?').get(sourceUserId);
            if (sourceUser) {
                // 1. Copy Providers
                const providerMap = {}; // oldId -> newId
                const sourceProviders = db.prepare('SELECT * FROM providers WHERE user_id = ?').all(sourceUserId);

                const insertProvider = db.prepare(`
                    INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, expiry_date, backup_urls, user_agent, max_connections, use_mapped_epg_icon, timeshift_timezone)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                for (const prov of sourceProviders) {
                    const result = insertProvider.run(
                        prov.name,
                        prov.url,
                        prov.username,
                        prov.password,
                        prov.epg_url,
                        newUserId,
                        prov.epg_update_interval,
                        prov.epg_enabled,
                        prov.expiry_date,
                        prov.backup_urls,
                        prov.user_agent,
                        prov.max_connections || 0,
                        prov.use_mapped_epg_icon ? 1 : 0,
                        prov.timeshift_timezone || null
                    );
                    providerMap[prov.id] = result.lastInsertRowid;
                }

                const oldProviderIdsForSync = Object.keys(providerMap);

                // 2. Copy Sync Configs
                if (oldProviderIdsForSync.length > 0) {
                    // Optimization: Use IN clause with provider_id (indexed) instead of user_id (not indexed)
                    const placeholders = Array(oldProviderIdsForSync.length).fill('?').join(',');
                    const sourceSyncs = db.prepare(`SELECT * FROM sync_configs WHERE provider_id IN (${placeholders})`).all(...oldProviderIdsForSync);
                    const insertSync = db.prepare(`
                        INSERT OR IGNORE INTO sync_configs (provider_id, user_id, enabled, sync_interval, auto_add_categories, auto_add_channels, sync_series_episodes, granted_by_admin)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
                    `);
                    for (const sync of sourceSyncs) {
                        insertSync.run(
                            providerMap[sync.provider_id],
                            newUserId,
                            sync.enabled,
                            sync.sync_interval,
                            sync.auto_add_categories,
                            sync.auto_add_channels,
                            sync.sync_series_episodes === undefined ? 1 : sync.sync_series_episodes
                        );
                    }
                }

                // 3. Copy Provider Channels (and keep map for user_channels)
                const channelMap = {}; // oldChannelId -> newChannelId
                const insertChannel = db.prepare(`
                    INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type, rating, rating_5based, added, plot, "cast", director, genre, releaseDate, youtube_trailer, episode_run_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                if (oldProviderIdsForSync.length > 0) {
                    const placeholders = Array(oldProviderIdsForSync.length).fill('?').join(',');
                    // Materialize before inserting. better-sqlite3 cannot execute INSERTs
                    // on the same connection while a SELECT iterator is still open.
                    const sourceChannels = db.prepare(`SELECT * FROM provider_channels WHERE provider_id IN (${placeholders})`).all(...oldProviderIdsForSync);

                    for (const ch of sourceChannels) {
                        const newProvId = providerMap[ch.provider_id];
                        if (!newProvId) continue;
                        if (ch.remote_stream_id === null || ch.remote_stream_id === undefined) {
                            console.warn(`Skipping cloned provider channel ${ch.id}: missing remote_stream_id`);
                            continue;
                        }

                        const result = insertChannel.run(
                            newProvId,
                            ch.remote_stream_id,
                            getClonedProviderChannelName(ch),
                            ch.original_category_id,
                            ch.logo,
                            ch.stream_type,
                            ch.epg_channel_id,
                            ch.original_sort_order,
                            ch.tv_archive,
                            ch.tv_archive_duration,
                            ch.metadata,
                            normalizeContainerExtension(ch.mime_type, ch.stream_type === 'live' ? 'ts' : 'mp4'),
                            ch.rating,
                            ch.rating_5based,
                            ch.added,
                            ch.plot,
                            ch.cast,
                            ch.director,
                            ch.genre,
                            ch.releaseDate,
                            ch.youtube_trailer,
                            ch.episode_run_time
                        );
                        channelMap[ch.id] = result.lastInsertRowid;
                    }
                }

                // 3b. Copy EPG Channel Mappings
                const insertEpgMap = db.prepare('INSERT OR IGNORE INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (?, ?)');
                // Optimization: Replace O(N) database queries with a single set-based lookup to avoid N+1 bottleneck
                const oldChannelIds = Object.keys(channelMap);
                if (oldChannelIds.length > 0) {
                    const BATCH_SIZE = 900; // SQLite limit for IN clause
                    for (let i = 0; i < oldChannelIds.length; i += BATCH_SIZE) {
                        const batch = oldChannelIds.slice(i, i + BATCH_SIZE);
                        // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
                        const placeholders = Array(batch.length).fill('?').join(',');
                        const mappings = db.prepare(`
                            SELECT provider_channel_id, epg_channel_id
                            FROM epg_channel_mappings
                            WHERE provider_channel_id IN (${placeholders})
                        `).all(...batch);

                        for (const m of mappings) {
                            const newChId = channelMap[m.provider_channel_id];
                            if (newChId) {
                                insertEpgMap.run(newChId, m.epg_channel_id);
                            }
                        }
                    }
                }

                // 4. Copy User Categories
                const categoryMap = {}; // oldCatId -> newCatId
                const sourceCats = db.prepare('SELECT * FROM user_categories WHERE user_id = ?').all(sourceUserId);
                const insertCat = db.prepare(`
                    INSERT INTO user_categories (user_id, name, sort_order, is_adult, type)
                    VALUES (?, ?, ?, ?, ?)
                `);

                for (const cat of sourceCats) {
                    const result = insertCat.run(
                        newUserId,
                        cat.name,
                        cat.sort_order,
                        cat.is_adult,
                        cat.type
                    );
                    categoryMap[cat.id] = result.lastInsertRowid;
                }

                // 5. Copy Category Mappings
                const sourceMappings = db.prepare('SELECT * FROM category_mappings WHERE user_id = ?').all(sourceUserId);
                const insertMapping = db.prepare(`
                    INSERT OR IGNORE INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);
                const findMapping = db.prepare(`
                    SELECT id FROM category_mappings
                    WHERE provider_id = ? AND user_id = ? AND provider_category_id = ?
                      AND COALESCE(category_type, 'live') = ?
                    ORDER BY id DESC LIMIT 1
                `);
                const mappingIdMap = new Map();

                for (const m of sourceMappings) {
                    if (providerMap[m.provider_id]) {
                        const categoryId = m.user_category_id ? categoryMap[m.user_category_id] : null;
                        const categoryType = m.category_type || 'live';
                        insertMapping.run(
                            providerMap[m.provider_id],
                            newUserId,
                            m.provider_category_id,
                            m.provider_category_name,
                            categoryId,
                            m.auto_created,
                            categoryType
                        );
                        const mapping = findMapping.get(
                            providerMap[m.provider_id], newUserId, m.provider_category_id, categoryType
                        );
                        if (mapping) mappingIdMap.set(Number(m.id), Number(mapping.id));
                    }
                }

                // 6. Copy User Channels
                // Fetch all user channels for source user categories
                const sourceUserChans = db.prepare(`
                    SELECT uc.user_category_id, uc.provider_channel_id, uc.sort_order, uc.custom_name,
                           uc.is_hidden, uc.mapping_id, uc.assignment_origin,
                           uc.granted_by_admin, uc.authorization_revoked
                    FROM user_channels uc
                    JOIN user_categories cat ON uc.user_category_id = cat.id
                    WHERE cat.user_id = ?
                `).all(sourceUserId);
                const getClonedMapping = db.prepare(`
                    SELECT id, provider_id, user_id, user_category_id, provider_category_id,
                           COALESCE(category_type, 'live') AS category_type
                    FROM category_mappings
                    WHERE id = ? AND user_id = ?
                `);
                const getClonedProvider = db.prepare("SELECT provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type FROM provider_channels WHERE id = ?");
                const getClonedCategory = db.prepare("SELECT COALESCE(type, 'live') AS type FROM user_categories WHERE id = ? AND user_id = ?");

                for (const uc of sourceUserChans) {
                    const newCatId = categoryMap[uc.user_category_id];
                    const newProvChanId = channelMap[uc.provider_channel_id];

                    if (newCatId && newProvChanId) {
                        const sourceOrigin = normalizeAssignmentOrigin(uc.assignment_origin, 'legacy');
                        const remappedMappingId = sourceOrigin === 'mapping'
                          ? mappingIdMap.get(Number(uc.mapping_id)) || null
                          : null;
                        const provider = getClonedProvider.get(newProvChanId);
                        const providerId = provider?.provider_id;
                        const categoryType = String(getClonedCategory.get(newCatId, newUserId)?.type || 'live');
                        upsertMergedUserChannelAssignment(db, {
                            user_category_id: Number(newCatId),
                            provider_channel_id: Number(newProvChanId),
                            sort_order: uc.sort_order,
                            custom_name: uc.custom_name || '',
                            is_hidden: Number(uc.is_hidden) === 1 ? 1 : 0,
                            assignment_origin: remappedMappingId ? 'mapping' : (sourceOrigin === 'mapping' ? 'legacy' : sourceOrigin),
                            mapping_id: remappedMappingId,
                            granted_by_admin: 0,
                            authorization_revoked: Number(uc.authorization_revoked) === 1 ? 1 : 0,
                            grant_valid: false
                        }, {
                            mappingValidator: mappingId => {
                                const mapping = getClonedMapping.get(Number(mappingId), newUserId);
                                return Boolean(mapping && Number(mapping.user_category_id) === Number(newCatId) &&
                                    Number(mapping.provider_id) === Number(providerId) &&
                                    Number(mapping.provider_category_id) === Number(provider?.original_category_id) &&
                                    String(mapping.category_type || 'live') === categoryType &&
                                    (String(provider?.stream_type || 'live') === String(mapping.category_type || 'live') ||
                                      String(provider?.stream_type || 'live') === 'live' && String(mapping.category_type || 'live') === 'radio'));
                            }
                        });
                    }
                }
            }
        }

        clearChannelsCache(newUserId);
        res.json({
          id: newUserId,
          message: 'User created successfully'
        });
    })();

  } catch (e) {
    console.error('Create user failed:', e.message);
    res.status(400).json({error: e.message});
  }
};

export const updateUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { username, password, webui_access, hdhr_enabled, max_connections, expiry_date, allowed_countries, notes } = req.body;

    // Get existing user
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'user not found'});

    const updates = [];
    const params = [];

    if (username) {
        if (typeof username !== 'string') {
             return res.status(400).json({ error: 'invalid_input_type' });
        }
        const u = username.trim();
        if (u.length < 3 || u.length > 50) {
            return res.status(400).json({ error: 'invalid_username_length' });
        }
        // Check uniqueness if username changed
        if (u !== existing.username) {
           const duplicate = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
           if (duplicate) return res.status(400).json({ error: 'username_taken' });

           const duplicateAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(u);
           if (duplicateAdmin) return res.status(400).json({ error: 'username_taken' });
        }
        updates.push('username = ?');
        params.push(u);
    }

    if (password) {
        if (typeof password !== 'string') {
             return res.status(400).json({ error: 'invalid_input_type' });
        }
        const p = password.trim();
        if (p.length < 8) {
            return res.status(400).json({ error: 'password_too_short' });
        }
        const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);
        const encryptedPlainPassword = encrypt(p);
        updates.push('password = ?');
        params.push(hashedPassword);

        updates.push('plain_password = ?');
        params.push(encryptedPlainPassword);

        updates.push('token_version = token_version + 1');

        // Security enhancement: Invalidate sessions and cached tokens
        db.prepare('DELETE FROM temporary_tokens WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(id);
        invalidateUserTokens(id);
    }

    if (webui_access !== undefined) {
        updates.push('webui_access = ?');
        params.push(webui_access ? 1 : 0);
    }

    if (hdhr_enabled !== undefined) {
        const isEnabled = hdhr_enabled ? 1 : 0;
        updates.push('hdhr_enabled = ?');
        params.push(isEnabled);

        if (isEnabled && !existing.hdhr_token) {
            const token = crypto.randomBytes(16).toString('hex');
            updates.push('hdhr_token = ?');
            params.push(token);
        }
    }

    if (max_connections !== undefined) {
        updates.push('max_connections = ?');
        params.push(Number(max_connections));
    }

    if (expiry_date !== undefined) {
        updates.push('expiry_date = ?');
        params.push(expiry_date || null);
        db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(id);
    }

    if (allowed_countries !== undefined) {
        updates.push('allowed_countries = ?');
        params.push((allowed_countries && allowed_countries !== 'null' && allowed_countries !== 'undefined') ? allowed_countries : null);
    }

    if (notes !== undefined) {
        if (notes && notes.length > 50) {
            return res.status(400).json({ error: 'notes_too_long' });
        }
        updates.push('notes = ?');
        params.push(notes ? notes.trim() : null);
    }

    if (updates.length === 0) return res.json({success: true}); // Nothing to update

    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Security Enhancement: Terminate active streams if security credentials/access changed
    if (password || expiry_date !== undefined || webui_access !== undefined || hdhr_enabled !== undefined || max_connections !== undefined || allowed_countries !== undefined) {
        try {
            const activeStreams = db.prepare('SELECT id FROM current_streams WHERE user_id = ?').all(id);
            for (const stream of activeStreams) {
                streamManager.remove(stream.id);
            }
        } catch (streamErr) {
            console.error(`Error terminating streams for user ${id}:`, streamErr);
        }

        // Ensure cache is fully cleared so new settings (like region lock) apply immediately
        invalidateUserTokens(id);
        invalidateUserCache(id);
    }

    clearChannelsCache(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteUser = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const ownedProviderUrls = db.prepare('SELECT url FROM providers WHERE user_id = ?').all(id).map(p => p.url);

    db.transaction(() => {
      // 1. Delete owned providers and their dependencies (optimized bulk deletes)
      db.prepare('DELETE FROM user_channels WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?))').run(id);
      db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?))').run(id);
      db.prepare('DELETE FROM stream_stats WHERE channel_id IN (SELECT id FROM provider_channels WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?))').run(id);
      db.prepare('DELETE FROM provider_channels WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)').run(id);

      db.prepare('DELETE FROM sync_configs WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)').run(id);
      db.prepare('DELETE FROM sync_logs WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)').run(id);
      db.prepare('DELETE FROM category_mappings WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)').run(id);
      db.prepare('DELETE FROM provider_icon_cache WHERE provider_id IN (SELECT id FROM providers WHERE user_id = ?)').run(id);
      db.prepare('DELETE FROM providers WHERE user_id = ?').run(id);

      // Episode data is shared per upstream panel; drop it only for panels
      // that no remaining provider row points at.
      if (ownedProviderUrls.length > 0) {
        const remainingKeys = new Set(db.prepare('SELECT url FROM providers').all().map(p => providerSourceKey(p.url)));
        const deleteEpisodesBySource = db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ?');
        const deleteStateBySource = db.prepare('DELETE FROM provider_series_state WHERE source_key = ?');
        for (const key of new Set(ownedProviderUrls.map(u => providerSourceKey(u)))) {
          if (!remainingKeys.has(key)) {
            deleteEpisodesBySource.run(key);
            deleteStateBySource.run(key);
          }
        }
      }

      // 2. Delete user data
      db.prepare('DELETE FROM user_channels WHERE user_category_id IN (SELECT id FROM user_categories WHERE user_id = ?)').run(id);

      // Update mappings to remove user_category_id reference before deleting categories
      db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(id);

      // Delete sync data
      db.prepare('DELETE FROM sync_configs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM sync_logs WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM category_mappings WHERE user_id = ?').run(id);

      db.prepare('DELETE FROM temporary_tokens WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM stalker_sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM stalker_devices WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM shared_links WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM user_backups WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();

    clearChannelsCache(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
