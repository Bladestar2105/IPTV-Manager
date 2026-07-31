export const SERIES_EPISODE_ALIAS_MIN = 900_000_000;
export const SERIES_EPISODE_OFFSET = 1_000_000_000;

export function decodeSeriesEpisodeId(value) {
  const encoded = Number(value);
  if (!Number.isSafeInteger(encoded) || encoded <= 0) return null;

  const assignmentId = Math.floor(encoded / SERIES_EPISODE_OFFSET);
  const remoteEpisodeId = encoded % SERIES_EPISODE_OFFSET;
  if (!assignmentId || !remoteEpisodeId) return null;

  return { assignmentId, remoteEpisodeId };
}
