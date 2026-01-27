import express from 'express';
import db from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { performSync } from '../services/syncService.js';
import { isAdultCategory } from '../utils/helpers.js';
import fetch from 'node-fetch';

const router = express.Router();

// Get providers (only for authenticated admin users)
router.get('/', authenticateToken, (req, res) => {
  try {
    const requestedUserId = req.query.user_id ? parseInt(req.query.user_id) : null;
    const currentUserId = req.user.userId || req.user.id;

    console.log('Get providers request:', {
      isAdmin: req.user.isAdmin,
      currentUserId,
      requestedUserId
    });

    let providers;

    if (req.user.isAdmin) {
      if (requestedUserId) {
        console.log(`Admin requesting providers for user ${requestedUserId}`);
        providers = db.prepare('SELECT * FROM providers WHERE user_id = ?').all(requestedUserId);
      } else {
        console.log('Admin requesting all providers');
        providers = db.prepare('SELECT * FROM providers').all();
      }
    } else {
      console.log(`Regular user requesting their own providers (user ${currentUserId})`);
      providers = db.prepare('SELECT * FROM providers WHERE user_id = ?').all(currentUserId);
    }

    console.log(`Returning ${providers.length} provider(s)`);
    res.json(providers);
  } catch (e) {
    console.error('Get providers error:', e.message);
    res.status(500).json({error: e.message});
  }
});

// Create provider (authenticated admin users only)
router.post('/', authenticateToken, (req, res) => {
  try {
    const { name, url, username, password, epg_url, user_id } = req.body;

    // Debug logging
    console.log('Provider creation request:', {
      name,
      url,
      username: username ? '***' : null,
      password: password ? '***' : null,
      epg_url,
      user_id,
      reqUser: req.user,
      reqUserUserId: req.user?.userId
    });

    if (!name || !url || !username || !password) {
      console.error('Missing required fields');
      return res.status(400).json({error: 'missing'});
    }

    if (!req.user || (!req.user.userId && !req.user.id)) {
      console.error('User not authenticated or userId missing');
      return res.status(401).json({error: 'User not authenticated'});
    }

    // Support both 'id' (old token format) and 'userId' (new token format)
    const currentUserId = req.user.userId || req.user.id;

    // Admin can create providers for any user, regular users create for themselves
    let targetUserId;
    if (req.user.isAdmin) {
      // Admin must select a user - admins cannot have providers
      if (!user_id || user_id === '' || user_id === 'null' || user_id === 'undefined') {
        console.error('Admin attempted to create provider without selecting a user');
        return res.status(400).json({error: 'Admin must select a user to create provider'});
      }
      targetUserId = parseInt(user_id);
      console.log(`Admin creating provider for user ${targetUserId}`);
      // Verify the user exists in users table (NOT admin_users!)
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId);
      if (!user) {
        console.error(`Invalid user_id: ${targetUserId} - user not found in users table`);
        return res.status(400).json({error: 'Invalid user_id'});
      }
    } else {
      // Regular user creates provider for themselves
      targetUserId = currentUserId;
      console.log(`Creating provider for current user ${targetUserId}`);
    }

    console.log(`Inserting provider with user_id: ${targetUserId} (token format: ${req.user.userId ? 'new' : 'old'})`);
    const info = db.prepare('INSERT INTO providers (user_id, name, url, username, password, epg_url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(targetUserId, name.trim(), url.trim(), username.trim(), password.trim(), (epg_url || '').trim());
    console.log(`Provider created with ID: ${info.lastInsertRowid}`);
    res.json({id: info.lastInsertRowid});
  } catch (e) {
    console.error('Provider creation error:', e.message);
    console.error('Error stack:', e.stack);
    res.status(500).json({error: e.message});
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({error: 'user_id required'});
    }

    const result = await performSync(id, user_id, true);

    if (result.errorMessage) {
      return res.status(500).json({error: result.errorMessage});
    }

    res.json({
      success: true,
      channels_added: result.channelsAdded,
      channels_updated: result.channelsUpdated,
      categories_added: result.categoriesAdded
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

router.get('/:id/channels', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM provider_channels WHERE provider_id = ? ORDER BY id').all(Number(req.params.id));
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Provider-Kategorien abrufen
router.get('/:id/categories', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'Provider not found'});

    let categories = [];

    try {
      const apiUrl = `${provider.url.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}&action=get_live_categories`;
      const resp = await fetch(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    const localCats = db.prepare(`
      SELECT DISTINCT original_category_id,
             COUNT(*) as channel_count
      FROM provider_channels
      WHERE provider_id = ? AND original_category_id > 0
      GROUP BY original_category_id
      ORDER BY channel_count DESC
    `).all(id);

    const merged = categories.map(cat => {
      const local = localCats.find(l => Number(l.original_category_id) === Number(cat.category_id));
      const isAdult = isAdultCategory(cat.category_name);

      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0,
        is_adult: isAdult
      };
    });

    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// Provider-Kategorie importieren
router.post('/:providerId/import-category', async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, category_id, category_name, import_channels } = req.body;

    if (!user_id || !category_id || !category_name) {
      return res.status(400).json({error: 'Missing required fields'});
    }

    const isAdult = isAdultCategory(category_name) ? 1 : 0;

    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(user_id);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const catInfo = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(user_id, category_name, isAdult, newSortOrder);
    const newCategoryId = catInfo.lastInsertRowid;

    if (import_channels) {
      const channels = db.prepare(`
        SELECT id FROM provider_channels
        WHERE provider_id = ? AND original_category_id = ?
        ORDER BY id
      `).all(providerId, Number(category_id));

      const insertChannel = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

      db.transaction(() => {
        channels.forEach((ch, idx) => {
          insertChannel.run(newCategoryId, ch.id, idx);
        });
      })();

      res.json({
        success: true,
        category_id: newCategoryId,
        channels_imported: channels.length,
        is_adult: isAdult
      });
    } else {
      res.json({
        success: true,
        category_id: newCategoryId,
        channels_imported: 0,
        is_adult: isAdult
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// Update provider (authenticated users only, can only update their own)
router.put('/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, url, username, password, epg_url } = req.body;
    if (!name || !url || !username || !password) {
      return res.status(400).json({error: 'missing fields'});
    }

    // Check ownership
    const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(id);
    if (!provider) {
      return res.status(404).json({error: 'Provider not found'});
    }

    // Admin can update any provider, regular users only their own
    if (!req.user.isAdmin && provider.user_id !== req.user.userId) {
      return res.status(403).json({error: 'Not authorized to update this provider'});
    }

    db.prepare(`
      UPDATE providers
      SET name = ?, url = ?, username = ?, password = ?, epg_url = ?
      WHERE id = ?
    `).run(name.trim(), url.trim(), username.trim(), password.trim(), (epg_url || '').trim(), id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Delete provider (authenticated users only, can only delete their own)
router.delete('/:id', authenticateToken, (req, res) => {
  try {
    const id = Number(req.params.id);

    // Check ownership
    const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(id);
    if (!provider) {
      return res.status(404).json({error: 'Provider not found'});
    }

    // Admin can delete any provider, regular users only their own
    if (!req.user.isAdmin && provider.user_id !== req.user.userId) {
      return res.status(403).json({error: 'Not authorized to delete this provider'});
    }

    db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

export default router;
