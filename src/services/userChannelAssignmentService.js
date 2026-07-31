export const ASSIGNMENT_ORIGINS = Object.freeze(['legacy', 'manual', 'mapping', 'imported']);

const ORIGIN_PRIORITY = Object.freeze({ manual: 0, legacy: 1, imported: 1, mapping: 2 });

export function normalizeAssignmentOrigin(value, fallback = 'legacy') {
  const origin = String(value || '').toLowerCase();
  return ASSIGNMENT_ORIGINS.includes(origin) ? origin : fallback;
}

export function isTrustedMappingAssignment(row, mappingId) {
  return normalizeAssignmentOrigin(row?.assignment_origin) === 'mapping' &&
    Number(row?.mapping_id) === Number(mappingId) && Number(mappingId) > 0;
}

export function mergeAssignmentCandidates(candidates, { mappingValidator } = {}) {
  const rows = candidates.map((candidate, index) => ({
    ...candidate,
    assignment_origin: normalizeAssignmentOrigin(candidate.assignment_origin),
    _source_index: index
  }));
  if (rows.length === 0) return null;

  const ordered = [...rows].sort((a, b) => {
    const priority = ORIGIN_PRIORITY[a.assignment_origin] - ORIGIN_PRIORITY[b.assignment_origin];
    if (priority !== 0) return priority;
    const aId = Number(a.id);
    const bId = Number(b.id);
    if (Number.isInteger(aId) && Number.isInteger(bId) && aId !== bId) return aId - bId;
    return a._source_index - b._source_index;
  });
  let preferred = ordered[0];
  let assignmentOrigin = preferred.assignment_origin;
  let mappingId = assignmentOrigin === 'mapping' ? Number(preferred.mapping_id) || null : null;
  if (assignmentOrigin === 'mapping') {
    const validMapping = ordered.find(row => {
      if (row.assignment_origin !== 'mapping') return false;
      const candidateMappingId = Number(row.mapping_id) || null;
      return candidateMappingId && row.mapping_valid !== false &&
        (!mappingValidator || mappingValidator(candidateMappingId, row));
    });
    if (validMapping) {
      preferred = validMapping;
      mappingId = Number(validMapping.mapping_id) || null;
    } else {
      assignmentOrigin = 'legacy';
      mappingId = null;
    }
  }

  const customName = ordered.find(row => String(row.custom_name || '').trim())?.custom_name || '';
  const sortOrders = rows
    .map(row => Number(row.sort_order))
    .filter(Number.isFinite);
  const validGrant = rows.some(row => (
    row.grant_valid === true ||
    row.grant_valid === undefined && Number(row.granted_by_admin) === 1 && Number(row.authorization_revoked) !== 1
  ));
  const requestedGrant = rows.some(row => Number(row.granted_by_admin) === 1);

  return {
    ...preferred,
    assignment_origin: assignmentOrigin,
    mapping_id: mappingId,
    is_hidden: rows.some(row => Number(row.is_hidden) === 1) ? 1 : 0,
    custom_name: customName,
    sort_order: sortOrders.length ? Math.min(...sortOrders) : 0,
    granted_by_admin: validGrant ? 1 : (requestedGrant ? 1 : 0),
    authorization_revoked: validGrant ? 0 : (rows.some(row => Number(row.authorization_revoked) === 1) ? 1 : 0)
  };
}

export function rebindSeriesEpisodeAliases(database, survivorId, loserId) {
  const aliasTable = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'series_episode_aliases'
  `).get();
  if (!aliasTable) return 0;

  const aliases = database.prepare(`
    SELECT id, source_key, series_remote_id, remote_episode_id
    FROM series_episode_aliases
    WHERE user_channel_id = ?
    ORDER BY id
  `).all(loserId);
  const findAlias = database.prepare(`
    SELECT id FROM series_episode_aliases
    WHERE user_channel_id = ? AND source_key = ?
      AND series_remote_id = ? AND remote_episode_id = ?
  `);
  const updateAlias = database.prepare('UPDATE series_episode_aliases SET user_channel_id = ? WHERE id = ?');
  const deleteAlias = database.prepare('DELETE FROM series_episode_aliases WHERE id = ?');
  let removed = 0;
  for (const alias of aliases) {
    const existing = findAlias.get(
      survivorId,
      alias.source_key,
      alias.series_remote_id,
      alias.remote_episode_id
    );
    if (existing) {
      deleteAlias.run(alias.id);
      removed++;
    } else {
      updateAlias.run(survivorId, alias.id);
    }
  }
  return removed;
}

function assignmentValues(row) {
  return [
    row.user_category_id,
    row.provider_channel_id,
    row.sort_order,
    row.custom_name || '',
    Number(row.is_hidden) === 1 ? 1 : 0,
    row.assignment_origin,
    row.mapping_id,
    Number(row.granted_by_admin) === 1 ? 1 : 0,
    Number(row.authorization_revoked) === 1 ? 1 : 0
  ];
}

export function upsertMergedUserChannelAssignment(database, candidate, {
  preserveId = false,
  mappingValidator
} = {}) {
  const categoryId = Number(candidate?.user_category_id);
  const providerChannelId = Number(candidate?.provider_channel_id);
  if (!Number.isInteger(categoryId) || categoryId <= 0 ||
      !Number.isInteger(providerChannelId) || providerChannelId <= 0) {
    return { inserted: 0, merged: 0, skipped: 1, hidden: 0, authorization_revoked: 0 };
  }

  const existing = database.prepare(`
    SELECT * FROM user_channels
    WHERE user_category_id = ? AND provider_channel_id = ?
    ORDER BY id
  `).all(categoryId, providerChannelId);
  const merged = mergeAssignmentCandidates([...existing, candidate], { mappingValidator });
  const candidateId = Number(candidate.id);
  const candidateAlreadyExists = existing.some(row => Number(row.id) === candidateId && candidateId > 0);

  if (existing.length === 0) {
    const idIsAvailable = preserveId && Number.isInteger(candidateId) && candidateId > 0 &&
      !database.prepare('SELECT id FROM user_channels WHERE id = ?').get(candidateId);
    const statement = idIsAvailable
      ? database.prepare(`
          INSERT INTO user_channels
            (id, user_category_id, provider_channel_id, sort_order, custom_name, is_hidden,
             assignment_origin, mapping_id, granted_by_admin, authorization_revoked)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
      : database.prepare(`
          INSERT INTO user_channels
            (user_category_id, provider_channel_id, sort_order, custom_name, is_hidden,
             assignment_origin, mapping_id, granted_by_admin, authorization_revoked)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
    const info = idIsAvailable
      ? statement.run(candidateId, ...assignmentValues(merged))
      : statement.run(...assignmentValues(merged));
    return {
      inserted: 1,
      merged: 0,
      skipped: 0,
      hidden: merged.is_hidden,
      authorization_revoked: merged.authorization_revoked,
      id: Number(idIsAvailable ? candidateId : info.lastInsertRowid),
      assignment_origin: merged.assignment_origin,
      mapping_id: merged.mapping_id
    };
  }

  const survivorId = Number(merged.id);
  const survivor = existing.find(row => Number(row.id) === survivorId) || existing[0];
  const loserRows = existing.filter(row => Number(row.id) !== Number(survivor.id));
  const update = database.prepare(`
    UPDATE user_channels
    SET sort_order = ?, custom_name = ?, is_hidden = ?, assignment_origin = ?,
        mapping_id = ?, granted_by_admin = ?, authorization_revoked = ?
    WHERE id = ?
  `);
  update.run(
    merged.sort_order,
    merged.custom_name || '',
    merged.is_hidden,
    merged.assignment_origin,
    merged.mapping_id,
    merged.granted_by_admin,
    merged.authorization_revoked,
    survivor.id
  );
  for (const loser of loserRows) {
    rebindSeriesEpisodeAliases(database, survivor.id, loser.id);
    database.prepare('DELETE FROM user_channels WHERE id = ?').run(loser.id);
  }

  return {
    inserted: 0,
    merged: loserRows.length + (candidateAlreadyExists ? 0 : 1),
    skipped: 0,
    hidden: merged.is_hidden,
    authorization_revoked: merged.authorization_revoked,
    id: survivor.id,
    assignment_origin: merged.assignment_origin,
    mapping_id: merged.mapping_id
  };
}
