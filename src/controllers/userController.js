import db from '../database/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { BCRYPT_ROUNDS } from '../config/constants.js';

export const getUsers = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const users = db.prepare('SELECT id, username, password, is_active, webui_access, hdhr_enabled, hdhr_token FROM users ORDER BY id').all();
    const result = users.map(u => {
        return {
            id: u.id,
            username: u.username,
            is_active: u.is_active,
            webui_access: u.webui_access,
            hdhr_enabled: u.hdhr_enabled,
            hdhr_token: u.hdhr_token
        };
    });
    res.json(result);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const { username, password, webui_access, hdhr_enabled, copy_from_user_id } = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'Username and password are required'
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

    let hdhrToken = null;
    const isHdhrEnabled = hdhr_enabled ? 1 : 0;
    if (isHdhrEnabled) {
        hdhrToken = crypto.randomBytes(16).toString('hex');
    }

    // Use transaction for atomic creation + copying
    db.transaction(() => {
        // Insert user
        const info = db.prepare('INSERT INTO users (username, password, webui_access, hdhr_enabled, hdhr_token) VALUES (?, ?, ?, ?, ?)').run(
            u,
            hashedPassword,
            webui_access !== undefined ? (webui_access ? 1 : 0) : 1,
            isHdhrEnabled,
            hdhrToken
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
                    INSERT INTO providers (name, url, username, password, epg_url, user_id, epg_update_interval, epg_enabled, user_agent, backup_urls, expiry_date)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        prov.user_agent,
                        prov.backup_urls,
                        prov.expiry_date
                    );
                    providerMap[prov.id] = result.lastInsertRowid;
                }

                // 2. Copy Sync Configs
                const sourceSyncs = db.prepare('SELECT * FROM sync_configs WHERE user_id = ?').all(sourceUserId);
                const insertSync = db.prepare(`
                    INSERT INTO sync_configs (provider_id, user_id, enabled, sync_interval, auto_add_categories, auto_add_channels)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);
                for (const sync of sourceSyncs) {
                    if (providerMap[sync.provider_id]) {
                        insertSync.run(
                            providerMap[sync.provider_id],
                            newUserId,
                            sync.enabled,
                            sync.sync_interval,
                            sync.auto_add_categories,
                            sync.auto_add_channels
                        );
                    }
                }

                // 3. Copy Provider Channels (and keep map for user_channels)
                const channelMap = {}; // oldChannelId -> newChannelId
                const insertChannel = db.prepare(`
                    INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, metadata, mime_type, rating, rating_5based, added, plot, "cast", director, genre, releaseDate, youtube_trailer, episode_run_time)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                // We need to fetch channels for each old provider
                for (const oldProvId of Object.keys(providerMap)) {
                    const newProvId = providerMap[oldProvId];
                    const channels = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ?').all(oldProvId);

                    for (const ch of channels) {
                        const result = insertChannel.run(
                            newProvId,
                            ch.remote_stream_id,
                            ch.name,
                            ch.original_category_id,
                            ch.logo,
                            ch.stream_type,
                            ch.epg_channel_id,
                            ch.original_sort_order,
                            ch.tv_archive,
                            ch.tv_archive_duration,
                            ch.metadata,
                            ch.mime_type,
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
                const insertEpgMap = db.prepare('INSERT INTO epg_channel_mappings (provider_channel_id, epg_channel_id) VALUES (?, ?)');
                // Get all mappings where provider_channel_id is in our key set
                // Efficient way: loop channelMap keys
                for (const oldChId of Object.keys(channelMap)) {
                    const mapping = db.prepare('SELECT epg_channel_id FROM epg_channel_mappings WHERE provider_channel_id = ?').get(oldChId);
                    if (mapping) {
                        insertEpgMap.run(channelMap[oldChId], mapping.epg_channel_id);
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
                    INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `);

                for (const m of sourceMappings) {
                    if (providerMap[m.provider_id]) {
                        insertMapping.run(
                            providerMap[m.provider_id],
                            newUserId,
                            m.provider_category_id,
                            m.provider_category_name,
                            m.user_category_id ? categoryMap[m.user_category_id] : null,
                            m.auto_created,
                            m.category_type || 'live'
                        );
                    }
                }

                // 6. Copy User Channels
                // We need to iterate over source user's categories to find channels
                // Or simply select all user_channels linked to source user's categories
                const insertUserChan = db.prepare(`
                    INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order)
                    VALUES (?, ?, ?)
                `);

                // Fetch all user channels for source user categories
                const sourceUserChans = db.prepare(`
                    SELECT uc.user_category_id, uc.provider_channel_id, uc.sort_order
                    FROM user_channels uc
                    JOIN user_categories cat ON uc.user_category_id = cat.id
                    WHERE cat.user_id = ?
                `).all(sourceUserId);

                for (const uc of sourceUserChans) {
                    const newCatId = categoryMap[uc.user_category_id];
                    const newProvChanId = channelMap[uc.provider_channel_id];

                    if (newCatId && newProvChanId) {
                        insertUserChan.run(newCatId, newProvChanId, uc.sort_order);
                    }
                }
            }
        }

        res.json({
          id: newUserId,
          message: 'User created successfully'
        });
    })();

  } catch (e) {
    res.status(400).json({error: e.message});
  }
};

export const updateUser = async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);
    const { username, password, webui_access, hdhr_enabled } = req.body;

    // Get existing user
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({error: 'user not found'});

    const updates = [];
    const params = [];

    if (username) {
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
        const p = password.trim();
        if (p.length < 8) {
            return res.status(400).json({ error: 'password_too_short' });
        }
        const hashedPassword = await bcrypt.hash(p, BCRYPT_ROUNDS);
        updates.push('password = ?');
        params.push(hashedPassword);
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

    if (updates.length === 0) return res.json({success: true}); // Nothing to update

    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteUser = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
    const id = Number(req.params.id);

    db.transaction(() => {
      // 1. Delete owned providers and their dependencies
      const userProviders = db.prepare('SELECT id FROM providers WHERE user_id = ?').all(id);
      for (const p of userProviders) {
        db.prepare('DELETE FROM user_channels WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM stream_stats WHERE channel_id IN (SELECT id FROM provider_channels WHERE provider_id = ?)').run(p.id);
        db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(p.id);

        db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(p.id);
        db.prepare('DELETE FROM providers WHERE id = ?').run(p.id);
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
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
