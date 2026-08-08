import db from '../database/db.js';
import { isAdultCategory, resolveAssignmentGrant } from '../utils/helpers.js';
import { clearChannelsCache } from '../services/cacheService.js';
import { upsertMergedUserChannelAssignment } from '../services/userChannelAssignmentService.js';
import {
  upsertCategoryMappingWithReconciliation,
  validateMappingAssignmentRelationship
} from '../services/categoryMappingService.js';
import { parseProviderCategoryId } from './providerControllerUtils.js';

export const importCategory = async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, category_id, category_name, import_channels, type } = req.body;
    const catType = type || 'live';
    const providerCategoryId = parseProviderCategoryId(category_id);

    if (!user_id || providerCategoryId === null || !category_name) {
      return res.status(400).json({error: 'Missing required fields'});
    }

    const targetUserId = Number(user_id);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({error: 'Invalid user_id'});
    }
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId)) {
      return res.status(404).json({error: 'User not found'});
    }
    const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
    if (!provider) return res.status(404).json({error: 'Provider not found'});
    if (!req.user.is_admin && targetUserId !== req.user.id) return res.status(403).json({error: 'Access denied'});
    const grantedByAdmin = resolveAssignmentGrant({
      categoryOwnerId: targetUserId,
      providerOwnerId: provider.user_id,
      isAdmin: req.user.is_admin,
      allowExplicitAdminGrant: true
    });
    if (grantedByAdmin === null) return res.status(403).json({error: 'Access denied'});

    const result = db.transaction(() => {
      const existing = db.prepare(`
        SELECT cm.*,
               COALESCE(cm.category_type, 'live') AS category_type,
               uc.user_id AS target_user_id,
               COALESCE(uc.type, 'live') AS target_category_type
        FROM category_mappings cm
        LEFT JOIN user_categories uc ON uc.id = cm.user_category_id
        WHERE cm.provider_id = ? AND cm.user_id = ? AND cm.provider_category_id = ?
          AND COALESCE(cm.category_type, 'live') = ?
      `).get(providerId, targetUserId, providerCategoryId, catType);
      const reusableTarget = existing && Number(existing.user_category_id) > 0 &&
        Number(existing.target_user_id) === targetUserId &&
        String(existing.target_category_type) === String(catType)
        ? Number(existing.user_category_id)
        : null;
      let targetCategoryId = reusableTarget;
      const isAdult = isAdultCategory(category_name) ? 1 : 0;
      if (!targetCategoryId) {
        const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(targetUserId);
        targetCategoryId = Number(db.prepare(`
          INSERT INTO user_categories (user_id, name, is_adult, sort_order, type)
          VALUES (?, ?, ?, ?, ?)
        `).run(targetUserId, category_name, isAdult, Number(maxSort?.max_sort ?? -1) + 1, catType).lastInsertRowid);
      }
      const mappingResult = upsertCategoryMappingWithReconciliation(db, {
        providerId,
        userId: targetUserId,
        providerCategoryId,
        providerCategoryName: category_name,
        categoryType: catType,
        targetCategoryId,
        autoCreated: 0
      });
      targetCategoryId = mappingResult.user_category_id;
      const mapping = mappingResult.mapping;
      let importedCount = 0;
      let mergedCount = 0;
      if (import_channels) {
        const streamType = catType === 'movie' || catType === 'series' ? catType : 'live';
        const channels = db.prepare(`
          SELECT id, provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type
          FROM provider_channels
          WHERE provider_id = ? AND original_category_id = ? AND COALESCE(stream_type, 'live') = ?
          ORDER BY original_sort_order ASC, name ASC, id
        `).all(providerId, providerCategoryId, streamType);
        channels.forEach((ch, idx) => {
          const valid = validateMappingAssignmentRelationship({
            mapping,
            userId: targetUserId,
            userCategoryId: targetCategoryId,
            userCategoryType: catType,
            providerId: ch.provider_id,
            providerCategoryId: ch.original_category_id,
            providerStreamType: ch.stream_type
          });
          const assignment = upsertMergedUserChannelAssignment(db, {
            user_category_id: targetCategoryId,
            provider_channel_id: ch.id,
            sort_order: idx,
            assignment_origin: valid ? 'mapping' : 'legacy',
            mapping_id: valid ? mapping.id : null,
            granted_by_admin: grantedByAdmin,
            authorization_revoked: 0,
            grant_valid: grantedByAdmin === 1,
            mapping_valid: valid
          }, { mappingValidator: mappingId => Number(mappingId) === Number(mapping?.id) && valid });
          importedCount += assignment.inserted;
          mergedCount += assignment.merged;
        });
      }
      return { targetCategoryId, mapping, isAdult, importedCount, mergedCount, reused: mappingResult.reused };
    })();

    clearChannelsCache(targetUserId);
    const response = {
      success: true,
      category_id: result.targetCategoryId,
      channels_imported: result.importedCount,
      is_adult: result.isAdult
    };
    if (result.mergedCount) response.channels_merged = result.mergedCount;
    if (result.reused) response.category_reused = true;
    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};

export const importCategories = async (req, res) => {
  try {
    const providerId = Number(req.params.providerId);
    const { user_id, categories } = req.body;

    if (!user_id || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({error: 'Missing required fields or invalid categories'});
    }

    const targetUserId = Number(user_id);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({error: 'Invalid user_id'});
    }
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId)) {
      return res.status(404).json({error: 'User not found'});
    }
    const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
    if (!provider) return res.status(404).json({error: 'Provider not found'});
    if (!req.user.is_admin && targetUserId !== req.user.id) return res.status(403).json({error: 'Access denied'});
    const grantedByAdmin = resolveAssignmentGrant({
      categoryOwnerId: targetUserId,
      providerOwnerId: provider.user_id,
      isAdmin: req.user.is_admin,
      allowExplicitAdminGrant: true
    });
    if (grantedByAdmin === null) return res.status(403).json({error: 'Access denied'});

    const results = [];
    let totalChannels = 0;
    let totalMerged = 0;
    let totalCategories = 0;

    const result = db.transaction(() => {
      let maxSort = Number(db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM user_categories WHERE user_id = ?').get(targetUserId).max_sort);
      for (const cat of categories) {
        const providerCategoryId = parseProviderCategoryId(cat.id);
        if (providerCategoryId === null || !cat.name) continue;
        const catType = cat.type || 'live';
        const existing = db.prepare(`
          SELECT cm.id, cm.user_category_id,
                 uc.user_id AS target_user_id, COALESCE(uc.type, 'live') AS target_category_type
          FROM category_mappings cm
          LEFT JOIN user_categories uc ON uc.id = cm.user_category_id
          WHERE cm.provider_id = ? AND cm.user_id = ? AND cm.provider_category_id = ?
            AND COALESCE(cm.category_type, 'live') = ?
        `).get(providerId, targetUserId, providerCategoryId, catType);
        const reusableTarget = existing && Number(existing.user_category_id) > 0 &&
          Number(existing.target_user_id) === targetUserId &&
          String(existing.target_category_type) === String(catType)
          ? Number(existing.user_category_id)
          : null;
        let targetCategoryId = reusableTarget;
        const isAdult = isAdultCategory(cat.name) ? 1 : 0;
        if (!targetCategoryId) {
          targetCategoryId = Number(db.prepare(`
            INSERT INTO user_categories (user_id, name, is_adult, sort_order, type)
            VALUES (?, ?, ?, ?, ?)
          `).run(targetUserId, cat.name, isAdult, ++maxSort, catType).lastInsertRowid);
        }
        const mappingResult = upsertCategoryMappingWithReconciliation(db, {
          providerId,
          userId: targetUserId,
          providerCategoryId,
          providerCategoryName: cat.name,
          categoryType: catType,
          targetCategoryId,
          autoCreated: 0
        });
        targetCategoryId = mappingResult.user_category_id;
        const mapping = mappingResult.mapping;
        let channelsImported = 0;
        if (cat.import_channels) {
          const streamType = catType === 'movie' || catType === 'series' ? catType : 'live';
          const channels = db.prepare(`
            SELECT id, provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type
            FROM provider_channels
            WHERE provider_id = ? AND original_category_id = ? AND COALESCE(stream_type, 'live') = ?
            ORDER BY original_sort_order ASC, name ASC, id
          `).all(providerId, providerCategoryId, streamType);
          channels.forEach((ch, idx) => {
            const valid = validateMappingAssignmentRelationship({
              mapping,
              userId: targetUserId,
              userCategoryId: targetCategoryId,
              userCategoryType: catType,
              providerId: ch.provider_id,
              providerCategoryId: ch.original_category_id,
              providerStreamType: ch.stream_type
            });
            const assignment = upsertMergedUserChannelAssignment(db, {
              user_category_id: targetCategoryId,
              provider_channel_id: ch.id,
              sort_order: idx,
              assignment_origin: valid ? 'mapping' : 'legacy',
              mapping_id: valid ? mapping.id : null,
              granted_by_admin: grantedByAdmin,
              authorization_revoked: 0,
              grant_valid: grantedByAdmin === 1,
              mapping_valid: valid
            }, { mappingValidator: mappingId => Number(mappingId) === Number(mapping?.id) && valid });
            channelsImported += assignment.inserted;
            totalChannels += assignment.inserted;
            totalMerged += assignment.merged;
          });
        }
        totalCategories++;
        results.push({ category_id: cat.id, new_id: targetCategoryId, name: cat.name, channels_imported: channelsImported });
      }
      return true;
    })();

    if (result) clearChannelsCache(targetUserId);

    const response = {
      success: true,
      categories_imported: totalCategories,
      channels_imported: totalChannels,
      results
    };
    if (totalMerged) response.channels_merged = totalMerged;
    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};
