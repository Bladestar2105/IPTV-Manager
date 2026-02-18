import db from '../database/db.js';
import { isAdultCategory } from '../utils/helpers.js';

export const getUserCategories = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({error: 'Access denied'});
    res.json(db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(userId));
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const createUserCategory = (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});

    const userId = Number(req.params.userId);
    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({error: 'Access denied'});
    const isAdult = isAdultCategory(name) ? 1 : 0;
    const catType = type || 'live';

    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const info = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)').run(userId, name.trim(), isAdult, newSortOrder, catType);
    res.json({id: info.lastInsertRowid, is_adult: isAdult, type: catType});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const updateUserCategory = (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(id);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const { name } = req.body;
    if (!name) return res.status(400).json({error: 'name required'});

    const isAdult = isAdultCategory(name) ? 1 : 0;
    db.prepare('UPDATE user_categories SET name = ?, is_adult = ? WHERE id = ?').run(name.trim(), isAdult, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const deleteUserCategory = (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(id);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);
    db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id = ?').run(id);
    db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);

    res.json({success: true});
  } catch (e) {
    console.error('Delete category error:', e);
    res.status(500).json({error: e.message});
  }
};

export const bulkDeleteUserCategories = (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({error: 'ids array required'});

    const placeholders = ids.map(() => '?').join(',');

    db.transaction(() => {
      if (!req.user.is_admin) {
        const cats = db.prepare(`SELECT id, user_id FROM user_categories WHERE id IN (${placeholders})`).all(...ids);
        const catMap = new Map(cats.map(c => [c.id, c.user_id]));
        for (const id of ids) {
          const catUserId = catMap.get(Number(id));
          if (catUserId === undefined || catUserId !== req.user.id) {
            throw new Error('Access denied');
          }
        }
      }

      db.prepare(`DELETE FROM user_channels WHERE user_category_id IN (${placeholders})`).run(...ids);
      db.prepare(`UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM user_categories WHERE id IN (${placeholders})`).run(...ids);
    })();

    res.json({success: true, deleted: ids.length});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const reorderUserCategories = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({error: 'Access denied'});

    const { category_ids } = req.body;
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
};

export const updateUserCategoryAdult = (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(id);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const { is_adult } = req.body;
    db.prepare('UPDATE user_categories SET is_adult = ? WHERE id = ?').run(is_adult ? 1 : 0, id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const getCategoryChannels = (req, res) => {
  try {
    const catId = Number(req.params.catId);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(catId);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const rows = db.prepare(`
      SELECT uc.id as user_channel_id, pc.*, map.epg_channel_id as manual_epg_id
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE uc.user_category_id = ?
      ORDER BY uc.sort_order
    `).all(catId);
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const addUserChannel = (req, res) => {
  try {
    const catId = Number(req.params.catId);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(catId);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const { provider_channel_id } = req.body;
    if (!provider_channel_id) return res.status(400).json({error: 'channel required'});

    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(catId);
    const newSortOrder = (maxSort?.max_sort || -1) + 1;

    const info = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)').run(catId, Number(provider_channel_id), newSortOrder);
    res.json({id: info.lastInsertRowid});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const reorderUserChannels = (req, res) => {
  try {
    const catId = Number(req.params.catId);
    if (!req.user.is_admin) {
        const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(catId);
        if (!cat || cat.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const { channel_ids } = req.body;
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
};

export const deleteUserChannel = (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!req.user.is_admin) {
        const channel = db.prepare(`
            SELECT cat.user_id
            FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            WHERE uc.id = ?
        `).get(id);
        if (!channel || channel.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    db.prepare('DELETE FROM user_channels WHERE id = ?').run(id);
    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};

export const bulkDeleteUserChannels = (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({error: 'ids array required'});

    if (!req.user.is_admin) {
        const placeholders = ids.map(() => '?').join(',');
        const channels = db.prepare(`
            SELECT cat.user_id
            FROM user_channels uc
            JOIN user_categories cat ON cat.id = uc.user_category_id
            WHERE uc.id IN (${placeholders})
        `).all(...ids);

        for (const ch of channels) {
            if (ch.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
        }
    }

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_channels WHERE id IN (${placeholders})`).run(...ids);

    res.json({success: true, deleted: ids.length});
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getCategoryMappings = (req, res) => {
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
};

export const updateCategoryMapping = (req, res) => {
  try {
    const id = Number(req.params.id);
    const { user_category_id } = req.body;

    db.prepare('UPDATE category_mappings SET user_category_id = ? WHERE id = ?')
      .run(user_category_id ? Number(user_category_id) : null, id);

    res.json({success: true});
  } catch (e) {
    res.status(500).json({error: e.message});
  }
};
