export const SERIES_EPISODE_ALIAS_MIN = 900_000_000;
export const SERIES_EPISODE_OFFSET = 1_000_000_000;

export function prepareSeriesEpisodeAliases(database) {
  return {
    insert: database.prepare(`
      INSERT OR IGNORE INTO series_episode_aliases
        (user_channel_id, source_key, series_remote_id, remote_episode_id)
      VALUES (?, ?, ?, ?)
    `),
    select: database.prepare(`
      SELECT id FROM series_episode_aliases
      WHERE user_channel_id = ? AND source_key = ? AND series_remote_id = ? AND remote_episode_id = ?
    `)
  };
}

export function getOrCreateSeriesEpisodeAlias(statements, userChannelId, sourceKey, seriesRemoteId, remoteEpisodeId) {
  const values = [Number(userChannelId), String(sourceKey || ''), Number(seriesRemoteId), Number(remoteEpisodeId)];
  if (!values[1] || !values.every((value, index) => index === 1 || (Number.isSafeInteger(value) && value > 0))) {
    return null;
  }

  let row = statements.select.get(...values);
  if (!row) {
    statements.insert.run(...values);
    row = statements.select.get(...values);
  }
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id >= SERIES_EPISODE_ALIAS_MIN && id < SERIES_EPISODE_OFFSET
    ? String(id)
    : null;
}

export function decodeSeriesEpisodeId(value) {
  const encoded = Number(value);
  if (!Number.isSafeInteger(encoded) || encoded <= 0) return null;

  const assignmentId = Math.floor(encoded / SERIES_EPISODE_OFFSET);
  const remoteEpisodeId = encoded % SERIES_EPISODE_OFFSET;
  if (!assignmentId || !remoteEpisodeId) return null;

  return { assignmentId, remoteEpisodeId };
}
