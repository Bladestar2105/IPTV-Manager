import { isAdultCategory, resolveAssignmentGrant } from '../utils/helpers.js';

function fail(status, message) {
  throw Object.assign(new Error(message), {status});
}

// Shared by the regular editor and confirmed AI proposals. The caller owns the
// transaction, cache invalidation and audit so compound changes stay atomic.
export function createCategory(database, userId, {name, type = 'live'}) {
  if (typeof name !== 'string' || !name.trim()) fail(400, 'name required');
  const isAdult = isAdultCategory(name) ? 1 : 0;
  const sortOrder = database.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_categories WHERE user_id = ?').get(userId).max_sort + 1;
  const info = database.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order, type) VALUES (?, ?, ?, ?, ?)')
    .run(userId, name.trim(), isAdult, sortOrder, type || 'live');
  return {id:Number(info.lastInsertRowid),user_id:userId,name:name.trim(),is_adult:isAdult,sort_order:sortOrder,type:type || 'live'};
}

export function addChannel(database, actor, categoryId, providerChannelId, {sortOrder} = {}) {
  const category = database.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(categoryId);
  if (!category) fail(404, 'Category not found');
  if (!actor.is_admin && category.user_id !== actor.id) fail(403, 'Access denied');
  if (!providerChannelId) fail(400, 'channel required');
  const channel = database.prepare(`SELECT pc.id, p.user_id FROM provider_channels pc
    JOIN providers p ON p.id = pc.provider_id WHERE pc.id = ?`).get(Number(providerChannelId));
  if (!channel) fail(404, 'Channel not found');
  const grant = resolveAssignmentGrant({categoryOwnerId:category.user_id,providerOwnerId:channel.user_id,isAdmin:actor.is_admin,allowExplicitAdminGrant:true});
  if (grant === null) fail(403, 'Access denied');
  const next = sortOrder ?? database.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM user_channels WHERE user_category_id = ?').get(categoryId).max_sort + 1;
  if (!Number.isSafeInteger(next) || next < 0) fail(400, 'Invalid sort order');
  const existing = database.prepare('SELECT id FROM user_channels WHERE user_category_id = ? AND provider_channel_id = ?').get(categoryId, Number(providerChannelId));
  if (existing) {
    database.prepare(`UPDATE user_channels SET is_hidden = 0, sort_order = ?, assignment_origin = 'manual',
      mapping_id = NULL, granted_by_admin = ?, authorization_revoked = 0 WHERE id = ?`).run(next,grant,existing.id);
    return {id:existing.id};
  }
  const info = database.prepare(`INSERT INTO user_channels
    (user_category_id,provider_channel_id,sort_order,assignment_origin,mapping_id,granted_by_admin,authorization_revoked)
    VALUES (?,?,?,'manual',NULL,?,0)`).run(categoryId,Number(providerChannelId),next,grant);
  return {id:Number(info.lastInsertRowid)};
}
