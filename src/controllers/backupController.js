import db from '../database/db.js';
import { clearChannelsCache } from '../services/cacheService.js';
import { resolveAssignmentGrant } from '../utils/helpers.js';
import {
  normalizeAssignmentOrigin,
  mergeAssignmentGroups,
  upsertMergedUserChannelAssignment
} from '../services/userChannelAssignmentService.js';
import {
  getCategoryMapping,
  retargetCategoryMapping,
  validateMappingTarget,
  validateMappingAssignmentRelationship,
  validateStoredMappingAssignment
} from '../services/categoryMappingService.js';

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
      format_version: 2,
      assignment_provenance_version: 1,
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
    const backupMappingTargets = new Map(
      data.categoryMappings
        .filter(map => Number.isInteger(Number(map.id)) && Number(map.id) > 0)
        .map(map => [Number(map.id), map])
    );
    const trustedFormat = Number(data.format_version) === 2 && Number(data.assignment_provenance_version) === 1;

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
      const getMapping = db.prepare(`
        SELECT id, provider_id, user_id, user_category_id, provider_category_id,
               COALESCE(category_type, 'live') AS category_type
        FROM category_mappings
        WHERE id = ? AND user_id = ?
      `);
      const getProviderOwner = db.prepare(`
        SELECT p.id AS provider_id, p.user_id AS provider_owner_id,
               pc.original_category_id, COALESCE(pc.stream_type, 'live') AS stream_type
        FROM provider_channels pc
        JOIN providers p ON p.id = pc.provider_id
        WHERE pc.id = ?
      `);
      const getCategoryType = db.prepare("SELECT COALESCE(type, 'live') AS type FROM user_categories WHERE id = ? AND user_id = ?");
      const updateMappingMetadata = db.prepare('UPDATE category_mappings SET auto_created = ? WHERE id = ? AND user_id = ?');

      for (const cat of data.userCategories) {
        insertCategory.run(cat.id, userId, cat.name, cat.sort_order, cat.is_adult, cat.type);
      }

      // Reconnect mappings before validating assignment provenance. This keeps the
      // relationship validator from observing a temporarily detached target.
      for (const map of data.categoryMappings) {
        const categoryId = Number(map.user_category_id);
        if (restoredCategoryIds.has(categoryId)) {
          const currentMapping = getCategoryMapping(db, map.id);
          if (currentMapping && Number(currentMapping.user_id) === userId) {
            if (validateMappingTarget(db, currentMapping, categoryId)) {
              if (!retargetCategoryMapping(db, currentMapping, categoryId)) {
                throw new Error('Mapping retarget failed');
              }
              updateMappingMetadata.run(map.auto_created ? 1 : 0, map.id, userId);
            }
          }
        }
      }

      const candidates = [];
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
          allowExplicitAdminGrant: req.body?.allow_cross_owner === true
        });
        const isHidden = Number(chan.is_hidden) === 1 ? 1 : 0;
        const authorizationRevoked = grant === null ||
          (Number(chan.authorization_revoked) === 1 && grant !== 1) ? 1 : 0;
        const sourceOrigin = trustedFormat
          ? normalizeAssignmentOrigin(chan.assignment_origin, 'legacy')
          : 'imported';
        const sourceMappingId = Number(chan.mapping_id);
        const sourceMapping = backupMappingTargets.get(sourceMappingId);
        const currentMapping = sourceOrigin === 'mapping' ? getMapping.get(sourceMappingId, userId) : null;
        const category = getCategoryType.get(categoryId, userId);
        const sourceValidationMapping = currentMapping && sourceMapping
          ? { ...currentMapping, ...sourceMapping,
              id: sourceMapping.id === undefined ? currentMapping.id : sourceMapping.id,
              provider_id: sourceMapping.provider_id === undefined ? currentMapping.provider_id : sourceMapping.provider_id,
              user_id: sourceMapping.user_id === undefined ? currentMapping.user_id : sourceMapping.user_id,
              user_category_id: sourceMapping.user_category_id === undefined ? currentMapping.user_category_id : sourceMapping.user_category_id,
              provider_category_id: sourceMapping.provider_category_id === undefined ? currentMapping.provider_category_id : sourceMapping.provider_category_id,
              category_type: sourceMapping.category_type === undefined ? currentMapping.category_type : sourceMapping.category_type }
          : null;
        const sourceValid = sourceOrigin === 'mapping' && sourceMapping && currentMapping &&
          Number(sourceValidationMapping.user_category_id) === categoryId &&
          validateMappingAssignmentRelationship({
            mapping: sourceValidationMapping,
            userId,
            userCategoryId: categoryId,
            userCategoryType: category?.type,
            providerId: provider.provider_id,
            providerCategoryId: provider.original_category_id,
            providerStreamType: provider.stream_type
          });
        const restoredMappingId = sourceValid && validateStoredMappingAssignment(db, {
          mappingId: sourceMappingId,
          userId,
          userCategoryId: categoryId,
          providerChannelId
        }) ? sourceMappingId : null;
        const validMapping = Boolean(restoredMappingId);
        candidates.push({
          id: chan.id,
          user_category_id: categoryId,
          provider_channel_id: providerChannelId,
          sort_order: chan.sort_order,
          custom_name: chan.custom_name || '',
          is_hidden: isHidden,
          assignment_origin: validMapping ? 'mapping' : (sourceOrigin === 'mapping' ? 'legacy' : sourceOrigin),
          mapping_id: restoredMappingId,
          granted_by_admin: grant === 1 ? 1 : 0,
          authorization_revoked: authorizationRevoked,
          grant_valid: grant === 1,
          mapping_valid: validMapping
        });
      }

      const grouped = mergeAssignmentGroups(candidates, { preserveLowestId: true });
      const getAssignmentById = db.prepare('SELECT id FROM user_channels WHERE id = ?');
      for (const group of grouped.groups) {
        const candidate = { ...group.candidate };
        candidate.id = group.validIds.find(id => !getAssignmentById.get(id)) || null;
        const result = upsertMergedUserChannelAssignment(db, candidate, {
          preserveId: true,
          mappingValidator: mappingId => validateStoredMappingAssignment(db, {
            mappingId,
            userId,
            userCategoryId: candidate.user_category_id,
            providerChannelId: candidate.provider_channel_id
          })
        });
        if (result.skipped) stats.channels_skipped++;
        else stats.channels_merged = (stats.channels_merged || 0) + group.duplicateCount + result.merged;
      }

      const categoryPlaceholders = [...restoredCategoryIds].map(() => '?').join(',');
      if (categoryPlaceholders) {
        const finalCounts = db.prepare(`
          SELECT
            SUM(CASE WHEN is_hidden = 0 AND authorization_revoked = 0 THEN 1 ELSE 0 END) AS restored,
            SUM(CASE WHEN is_hidden = 1 OR authorization_revoked = 1 THEN 1 ELSE 0 END) AS hidden
          FROM user_channels
          WHERE user_category_id IN (${categoryPlaceholders})
        `).get(...restoredCategoryIds);
        stats.channels_restored = Number(finalCounts?.restored || 0);
        stats.channels_hidden = Number(finalCounts?.hidden || 0);
      }
    })();

    clearChannelsCache(userId);
    if (!stats.channels_merged) delete stats.channels_merged;
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
