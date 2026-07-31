import {
  mergeAssignmentCandidates,
  rebindSeriesEpisodeAliases
} from './userChannelAssignmentService.js';

const normalizeType = value => String(value || 'live').toLowerCase();

export function validateMappingAssignmentRelationship({
  mapping,
  userId,
  userCategoryId,
  userCategoryType,
  providerId,
  providerCategoryId,
  providerStreamType
} = {}) {
  if (!mapping) return false;

  const mappingProviderCategoryId = Number(mapping.provider_category_id);
  const restoredProviderCategoryId = Number(providerCategoryId);
  if (!Number.isInteger(Number(mapping.id)) || Number(mapping.id) <= 0 ||
      !Number.isInteger(Number(mapping.user_id)) || Number(mapping.user_id) !== Number(userId) ||
      !Number.isInteger(Number(mapping.user_category_id)) || Number(mapping.user_category_id) !== Number(userCategoryId) ||
      !Number.isInteger(Number(mapping.provider_id)) || Number(mapping.provider_id) !== Number(providerId) ||
      !Number.isInteger(mappingProviderCategoryId) || !Number.isInteger(restoredProviderCategoryId) ||
      mappingProviderCategoryId !== restoredProviderCategoryId) {
    return false;
  }

  const mappingType = normalizeType(mapping.category_type);
  const categoryType = normalizeType(userCategoryType);
  const streamType = normalizeType(providerStreamType);
  return mappingType === categoryType &&
    ((mappingType !== 'radio' && streamType === mappingType) ||
      (streamType === 'live' && mappingType === 'radio'));
}

const mappingSelect = `
  SELECT id, provider_id, user_id, provider_category_id, provider_category_name,
         user_category_id, auto_created, COALESCE(category_type, 'live') AS category_type
  FROM category_mappings
`;

export function getCategoryMapping(database, mappingId) {
  return database.prepare(`${mappingSelect} WHERE id = ?`).get(mappingId);
}

export function validateStoredMappingAssignment(database, {
  mappingId,
  userId,
  userCategoryId,
  providerChannelId
} = {}) {
  const mapping = getCategoryMapping(database, mappingId);
  const category = database.prepare(`
    SELECT id, user_id, COALESCE(type, 'live') AS type
    FROM user_categories
    WHERE id = ?
  `).get(userCategoryId);
  const channel = database.prepare(`
    SELECT provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type
    FROM provider_channels
    WHERE id = ?
  `).get(providerChannelId);
  return Boolean(category && channel && category.user_id === Number(userId) &&
    validateMappingAssignmentRelationship({
      mapping,
      userId,
      userCategoryId,
      userCategoryType: category.type,
      providerId: channel.provider_id,
      providerCategoryId: channel.original_category_id,
      providerStreamType: channel.stream_type
    }));
}

export function validateMappingTarget(database, mapping, targetId) {
  if (targetId === null) return true;
  const target = database.prepare(`
    SELECT id, user_id, COALESCE(type, 'live') AS type
    FROM user_categories
    WHERE id = ?
  `).get(targetId);
  return Boolean(target && Number(target.user_id) === Number(mapping.user_id) &&
    normalizeType(target.type) === normalizeType(mapping.category_type));
}

export function reconcileMappingAssignments(database, mapping, targetId, { mappingValidator } = {}) {
  const ownedAssignments = database.prepare(`
    SELECT uc.*
    FROM user_channels uc
    WHERE uc.mapping_id = ? AND uc.assignment_origin = 'mapping'
    ORDER BY uc.id
  `).all(mapping.id);

  if (targetId === null) {
    const remove = database.prepare(`
      DELETE FROM user_channels
      WHERE id = ? AND mapping_id = ? AND assignment_origin = 'mapping'
    `);
    let removed = 0;
    for (const assignment of ownedAssignments) removed += remove.run(assignment.id, mapping.id).changes;
    return { assignments_removed: removed, assignments_moved: 0, duplicates_merged: 0 };
  }

  if (!validateMappingTarget(database, mapping, targetId)) return null;

  const target = database.prepare(`
    SELECT id, user_id, COALESCE(type, 'live') AS type
    FROM user_categories
    WHERE id = ?
  `).get(targetId);
  const findTarget = database.prepare(`
    SELECT * FROM user_channels
    WHERE user_category_id = ? AND provider_channel_id = ?
    ORDER BY id
  `);
  const update = database.prepare(`
    UPDATE user_channels
    SET user_category_id = ?, sort_order = ?, custom_name = ?, is_hidden = ?,
        assignment_origin = ?, mapping_id = ?, granted_by_admin = ?, authorization_revoked = ?
    WHERE id = ?
  `);
  const deleteAssignment = database.prepare('DELETE FROM user_channels WHERE id = ?');

  const isValidMapping = (mappingId, row) => {
    if (mappingValidator) return mappingValidator(mappingId, row);
    const provider = database.prepare(`
      SELECT provider_id, original_category_id, COALESCE(stream_type, 'live') AS stream_type
      FROM provider_channels
      WHERE id = ?
    `).get(row?.provider_channel_id);
    const candidate = Number(mappingId) === Number(mapping.id)
      ? { ...mapping, user_category_id: targetId }
      : getCategoryMapping(database, mappingId);
    return Boolean(provider && validateMappingAssignmentRelationship({
      mapping: candidate,
      userId: mapping.user_id,
      userCategoryId: targetId,
      userCategoryType: target.type,
      providerId: provider.provider_id,
      providerCategoryId: provider.original_category_id,
      providerStreamType: provider.stream_type
    }));
  };

  let assignmentsMoved = 0;
  let duplicatesMerged = 0;
  for (const assignment of ownedAssignments) {
    const mappingValid = isValidMapping(mapping.id, {
      ...assignment,
      user_category_id: targetId
    });
    if (Number(assignment.user_category_id) === Number(targetId)) {
      if (!mappingValid) {
        update.run(
          assignment.user_category_id,
          assignment.sort_order,
          assignment.custom_name || '',
          Number(assignment.is_hidden) === 1 ? 1 : 0,
          'legacy',
          null,
          Number(assignment.granted_by_admin) === 1 ? 1 : 0,
          Number(assignment.authorization_revoked) === 1 ? 1 : 0,
          assignment.id
        );
      }
      continue;
    }
    const targetRows = findTarget.all(targetId, assignment.provider_channel_id);
    if (targetRows.length === 0) {
      if (!mappingValid) {
        update.run(
          assignment.user_category_id,
          assignment.sort_order,
          assignment.custom_name || '',
          Number(assignment.is_hidden) === 1 ? 1 : 0,
          'legacy',
          null,
          Number(assignment.granted_by_admin) === 1 ? 1 : 0,
          Number(assignment.authorization_revoked) === 1 ? 1 : 0,
          assignment.id
        );
        continue;
      }
      if (update.run(
        targetId,
        assignment.sort_order,
        assignment.custom_name || '',
        Number(assignment.is_hidden) === 1 ? 1 : 0,
        'mapping',
        mapping.id,
        Number(assignment.granted_by_admin) === 1 ? 1 : 0,
        Number(assignment.authorization_revoked) === 1 ? 1 : 0,
        assignment.id
      ).changes === 1) assignmentsMoved++;
      continue;
    }

    const merged = mergeAssignmentCandidates(
      [...targetRows, { ...assignment, user_category_id: targetId }],
      { mappingValidator: isValidMapping }
    );
    const survivorId = Number(merged.id);
    const survivorIsSource = survivorId === Number(assignment.id);
    const survivor = survivorIsSource
      ? assignment
      : targetRows.find(row => Number(row.id) === survivorId) || targetRows[0];
    const losers = targetRows.filter(row => Number(row.id) !== Number(survivor.id));

    if (survivorIsSource) {
      for (const loser of targetRows) {
        rebindSeriesEpisodeAliases(database, assignment.id, loser.id);
        deleteAssignment.run(loser.id);
      }
      update.run(
        targetId,
        merged.sort_order,
        merged.custom_name || '',
        merged.is_hidden,
        merged.assignment_origin,
        merged.mapping_id,
        merged.granted_by_admin,
        merged.authorization_revoked,
        assignment.id
      );
      assignmentsMoved++;
    } else {
      update.run(
        targetId,
        merged.sort_order,
        merged.custom_name || '',
        merged.is_hidden,
        merged.assignment_origin,
        merged.mapping_id,
        merged.granted_by_admin,
        merged.authorization_revoked,
        survivor.id
      );
      for (const loser of losers) {
        rebindSeriesEpisodeAliases(database, survivor.id, loser.id);
        deleteAssignment.run(loser.id);
      }
      rebindSeriesEpisodeAliases(database, survivor.id, assignment.id);
      deleteAssignment.run(assignment.id);
    }
    duplicatesMerged++;
  }

  return { assignments_removed: 0, assignments_moved: assignmentsMoved, duplicates_merged: duplicatesMerged };
}

export function retargetCategoryMapping(database, mapping, targetId) {
  if (!validateMappingTarget(database, mapping, targetId)) return null;
  const reconciliation = reconcileMappingAssignments(database, mapping, targetId);
  if (!reconciliation) return null;
  const updated = database.prepare(`
    UPDATE category_mappings
    SET user_category_id = ?
    WHERE id = ? AND user_id = ?
  `).run(targetId, mapping.id, mapping.user_id).changes === 1;
  return updated ? { success: true, ...reconciliation } : null;
}

export function unmapCategoryMapping(database, mapping) {
  return retargetCategoryMapping(database, mapping, null);
}

export function upsertCategoryMappingWithReconciliation(database, {
  providerId,
  userId,
  providerCategoryId,
  providerCategoryName,
  categoryType = 'live',
  targetCategoryId,
  autoCreated = 0
} = {}) {
  const existing = database.prepare(`${mappingSelect}
    WHERE provider_id = ? AND user_id = ? AND provider_category_id = ?
      AND COALESCE(category_type, 'live') = ?
  `).get(providerId, userId, providerCategoryId, categoryType);

  if (!existing) {
    if (!targetCategoryId) throw new Error('Mapping target required');
    const info = database.prepare(`
      INSERT INTO category_mappings
        (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created, category_type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(providerId, userId, providerCategoryId, providerCategoryName, targetCategoryId, autoCreated, categoryType);
    return {
      mapping: getCategoryMapping(database, info.lastInsertRowid),
      user_category_id: Number(targetCategoryId),
      reused: false,
      retargeted: false
    };
  }

  if (existing.user_category_id && validateMappingTarget(database, existing, existing.user_category_id)) {
    const reconciliation = reconcileMappingAssignments(database, existing, existing.user_category_id);
    if (!reconciliation) throw new Error('Invalid mapping target');
    database.prepare(`
      UPDATE category_mappings
      SET provider_category_name = ?, auto_created = ?
      WHERE id = ?
    `).run(providerCategoryName, autoCreated, existing.id);
    return {
      mapping: getCategoryMapping(database, existing.id),
      user_category_id: Number(existing.user_category_id),
      reused: true,
      retargeted: false,
      reconciliation
    };
  }

  if (!targetCategoryId) throw new Error('Mapping target required');
  const retargeted = retargetCategoryMapping(database, existing, targetCategoryId);
  if (!retargeted) throw new Error('Invalid mapping target');
  database.prepare(`
    UPDATE category_mappings
    SET provider_category_name = ?, auto_created = ?, category_type = ?
    WHERE id = ?
  `).run(providerCategoryName, autoCreated, categoryType, existing.id);
  return {
    mapping: getCategoryMapping(database, existing.id),
    user_category_id: Number(targetCategoryId),
    reused: false,
    retargeted: true,
    reconciliation: retargeted
  };
}
