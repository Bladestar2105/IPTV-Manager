import db from '../database/db.js';
import { clearChannelsCache } from '../services/cacheService.js';
import { resolveAssignmentGrant } from '../utils/helpers.js';

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
      // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
      const placeholders = Array(categoryIds.length).fill('?').join(',');
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
    if (!Array.isArray(data.userCategories) || !Array.isArray(data.userChannels) || !Array.isArray(data.categoryMappings)) {
      return res.status(400).json({ error: 'Invalid backup data' });
    }
    const restoredCategoryIds = new Set(data.userCategories.map(cat => Number(cat.id)));
    if ([...restoredCategoryIds].some(id => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: 'Invalid backup data' });
    }

    const stats = { channels_restored: 0, channels_hidden: 0, channels_skipped: 0 };

    db.transaction(() => {
      // Get current category ids for user
      const currentCategories = db.prepare('SELECT id FROM user_categories WHERE user_id = ?').all(userId);
      const currentCategoryIds = currentCategories.map(c => c.id);

      if (currentCategoryIds.length > 0) {
        // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
        const placeholders = Array(currentCategoryIds.length).fill('?').join(',');
        db.prepare(`DELETE FROM user_channels WHERE user_category_id IN (${placeholders})`).run(...currentCategoryIds);
        db.prepare(`UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id IN (${placeholders})`).run(...currentCategoryIds);
      }
      db.prepare('DELETE FROM user_categories WHERE user_id = ?').run(userId);

      // Insert backup data
      const insertCategory = db.prepare('INSERT INTO user_categories (id, user_id, name, sort_order, is_adult, type) VALUES (?, ?, ?, ?, ?, ?)');
      const insertChannel = db.prepare(`
        INSERT INTO user_channels
          (id, user_category_id, provider_channel_id, sort_order, custom_name, is_hidden, granted_by_admin)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const getProviderOwner = db.prepare(`
        SELECT p.user_id AS provider_owner_id
        FROM provider_channels pc
        JOIN providers p ON p.id = pc.provider_id
        WHERE pc.id = ?
      `);
      const updateMapping = db.prepare('UPDATE category_mappings SET user_category_id = ?, auto_created = ? WHERE id = ? AND user_id = ?');

      for (const cat of data.userCategories) {
        insertCategory.run(cat.id, userId, cat.name, cat.sort_order, cat.is_adult, cat.type);
      }

      for (const chan of data.userChannels) {
        const categoryId = Number(chan.user_category_id);
        const providerChannelId = Number(chan.provider_channel_id);
        if (!restoredCategoryIds.has(categoryId) || !Number.isInteger(providerChannelId) || providerChannelId <= 0) {
          stats.channels_skipped++;
          continue;
        }

        const provider = getProviderOwner.get(providerChannelId);
        if (!provider) {
          stats.channels_skipped++;
          continue;
        }

        const grant = resolveAssignmentGrant({
          categoryOwnerId: userId,
          providerOwnerId: provider.provider_owner_id,
          isAdmin: req.user.is_admin,
          allowExplicitAdminGrant: true
        });
        const isHidden = Number(chan.is_hidden) === 1 || grant === null ? 1 : 0;

        insertChannel.run(
          chan.id,
          categoryId,
          providerChannelId,
          chan.sort_order,
          chan.custom_name || '',
          isHidden,
          grant === 1 ? 1 : 0
        );
        if (isHidden) stats.channels_hidden++;
        else stats.channels_restored++;
      }

      for (const map of data.categoryMappings) {
        const categoryId = Number(map.user_category_id);
        if (restoredCategoryIds.has(categoryId)) {
          updateMapping.run(categoryId, map.auto_created ? 1 : 0, map.id, userId);
        }
      }
    })();

    clearChannelsCache(userId);
    res.json({ success: true, ...stats });
  } catch (error) {
    console.error('Restore backup error:', error);
    res.status(500).json({ error: 'Restore failed' });
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
