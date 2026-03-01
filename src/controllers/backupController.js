import db from '../database/db.js';

export const getBackups = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({ error: 'Access denied' });

    const backups = db.prepare('SELECT id, user_id, name, timestamp, category_count, channel_count FROM user_backups WHERE user_id = ? ORDER BY timestamp DESC').all(userId);
    res.json(backups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const createBackup = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({ error: 'Access denied' });

    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Name is required' });

    // Check backup limit
    const backupCount = db.prepare('SELECT COUNT(*) as count FROM user_backups WHERE user_id = ?').get(userId).count;
    if (backupCount >= 5) {
      return res.status(400).json({ error: 'Backup limit reached' });
    }

    // Collect data
    const userCategories = db.prepare('SELECT * FROM user_categories WHERE user_id = ?').all(userId);
    const categoryIds = userCategories.map(c => c.id);

    let userChannels = [];
    let categoryMappings = [];

    if (categoryIds.length > 0) {
      const placeholders = categoryIds.map(() => '?').join(',');
      userChannels = db.prepare(`SELECT * FROM user_channels WHERE user_category_id IN (${placeholders})`).all(...categoryIds);
      categoryMappings = db.prepare(`SELECT * FROM category_mappings WHERE user_category_id IN (${placeholders})`).all(...categoryIds);
    }

    const backupData = JSON.stringify({
      userCategories,
      userChannels,
      categoryMappings
    });

    const info = db.prepare(`
      INSERT INTO user_backups (user_id, name, timestamp, category_count, channel_count, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, name.trim(), Date.now(), userCategories.length, userChannels.length, backupData);

    res.json({ id: info.lastInsertRowid, success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const restoreBackup = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const backupId = Number(req.params.id);

    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({ error: 'Access denied' });

    const backup = db.prepare('SELECT * FROM user_backups WHERE id = ? AND user_id = ?').get(backupId, userId);
    if (!backup) return res.status(404).json({ error: 'Backup not found' });

    const data = JSON.parse(backup.data);

    db.transaction(() => {
      // Get current category ids for user
      const currentCategories = db.prepare('SELECT id FROM user_categories WHERE user_id = ?').all(userId);
      const currentCategoryIds = currentCategories.map(c => c.id);

      if (currentCategoryIds.length > 0) {
        const placeholders = currentCategoryIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM user_channels WHERE user_category_id IN (${placeholders})`).run(...currentCategoryIds);
        db.prepare(`UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id IN (${placeholders})`).run(...currentCategoryIds);
      }
      db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(userId);

      // Insert backup data
      const insertCategory = db.prepare('INSERT INTO user_categories (id, user_id, name, sort_order, is_adult, type) VALUES (?, ?, ?, ?, ?, ?)');
      const insertChannel = db.prepare('INSERT INTO user_channels (id, user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?, ?)');
      const updateMapping = db.prepare('UPDATE category_mappings SET user_category_id = ?, auto_created = ? WHERE id = ?');

      for (const cat of data.userCategories) {
        insertCategory.run(cat.id, cat.user_id, cat.name, cat.sort_order, cat.is_adult, cat.type);
      }

      for (const chan of data.userChannels) {
        insertChannel.run(chan.id, chan.user_category_id, chan.provider_channel_id, chan.sort_order);
      }

      for (const map of data.categoryMappings) {
        updateMapping.run(map.user_category_id, map.auto_created, map.id);
      }
    })();

    // Need to clear cache after modifying channels
    import('../services/cacheService.js').then(({ clearChannelsCache }) => {
        clearChannelsCache(userId);
    }).catch(console.error);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const deleteBackup = (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const backupId = Number(req.params.id);

    if (!req.user.is_admin && req.user.id !== userId) return res.status(403).json({ error: 'Access denied' });

    const info = db.prepare('DELETE FROM user_backups WHERE id = ? AND user_id = ?').run(backupId, userId);
    if (info.changes === 0) return res.status(404).json({ error: 'Backup not found' });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
