import express from 'express';
import db from '../config/database.js';
import { isAdultCategory } from '../utils/helpers.js';

const router = express.Router();

// Get user categories
router.get('/users/:userId/categories', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(Number(req.params.userId)));
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Create user category
router.post('/users/:userId/categories', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});

    const userId = Number(req.params.userId);
    const isAdult = isAdultCategory(name) ? 1 : 0;

    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const info = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)').run(userId, name.trim(), isAdult, newSortOrder);
    res.json({id: info.lastInsertRowid, is_adult: isAdult});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Reorder user categories
router.put('/users/:userId/categories/reorder', (req, res) => {
  try {
    const { category_ids } = req.body; // Array von IDs in neuer Reihenfolge
    if (!Array.isArray(category_ids)) return res.status(400).json({error: 'category_ids must be array'});

    const update = db.prepare('UPDATE user_categories SET sort_order = ? WHERE id = ?');

    db.transaction(() => {
      category_ids.forEach((catId, index) => {
        update.run(index, catId);
      });
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Get channels in user category
router.get('/user-categories/:catId/channels', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT uc.id as user_channel_id, pc.*
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      WHERE uc.user_category_id = ?
      ORDER BY uc.sort_order
    `).all(Number(req.params.catId));
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Add channel to user category
router.post('/user-categories/:catId/channels', (req, res) => {
  try {
    const catId = Number(req.params.catId);
    const { provider_channel_id } = req.body;
    if (!provider_channel_id) return res.status(400).json({error: 'channel required'});

    // Höchste sort_order finden
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(catId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const info = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)').run(catId, Number(provider_channel_id), newSortOrder);
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
});

// Reorder channels in category
router.put('/user-categories/:catId/channels/reorder', (req, res) => {
  try {
    const { channel_ids } = req.body; // Array von user_channel IDs in neuer Reihenfolge
    if (!Array.isArray(channel_ids)) return res.status(400).json({error: 'channel_ids must be array'});

    const update = db.prepare('UPDATE user_channels SET sort_order = ? WHERE id = ?');

    db.transaction(() => {
      channel_ids.forEach((chId, index) => {
        update.run(index, chId);
      });
    })();

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Update user category
router.put('/user-categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});

    const isAdult = isAdultCategory(name) ? 1 : 0;
    db.prepare('UPDATE user_categories SET name = ?, is_adult = ? WHERE id = ?').run(name.trim(), isAdult, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Delete user category
router.delete('/user-categories/:id', (req, res) => {
  try {
    const id = Number(req.params.id);

    // Delete in correct order to avoid foreign key constraints
    // 1. Delete channels in this category
    db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);

    // 2. Update category mappings (set user_category_id to NULL instead of deleting)
    db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id = ?').run(id);

    // 3. Delete the category itself
    db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);

    res.json({success: true});
  } catch (e) {
    console.error('Delete category error:', e);
    res.status(500).json({error: e.message});
  }
});

// Update adult status
router.put('/user-categories/:id/adult', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { is_adult } = req.body;
    db.prepare('UPDATE user_categories SET is_adult = ? WHERE id = ?').run(is_adult ? 1 : 0, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

// Category Mappings APIs
router.get('/category-mappings/:providerId/:userId', (req, res) => {
  try {
    const mappings = db.prepare(`
      SELECT cm.*, uc.name as user_category_name
      FROM category_mappings cm
      LEFT JOIN user_categories uc ON uc.id = cm.user_category_id
      WHERE cm.provider_id = ? AND cm.user_id = ?
      ORDER BY cm.provider_category_name
    `).all(Number(req.params.providerId), Number(req.params.userId));
    res.json(mappings);
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

router.put('/category-mappings/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_category_id } = req.body;

    db.prepare('UPDATE category_mappings SET user_category_id = ? WHERE id = ?')
      .run(user_category_id ? Number(user_category_id) : null, id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

export default router;
