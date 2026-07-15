export const SERIES_EPISODE_OFFSET = 1_000_000_000;

export function encodeSeriesEpisodeId(userChannelId, remoteEpisodeId) {
  const assignmentId = Number(userChannelId);
  const episodeId = Number(remoteEpisodeId);
  const encoded = assignmentId * SERIES_EPISODE_OFFSET + episodeId;

  if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0 ||
      !Number.isSafeInteger(episodeId) || episodeId <= 0 || episodeId >= SERIES_EPISODE_OFFSET ||
      !Number.isSafeInteger(encoded)) return null;

  return String(encoded);
}

export function decodeSeriesEpisodeId(value) {
  const encoded = Number(value);
  if (!Number.isSafeInteger(encoded) || encoded <= 0) return null;

  const assignmentId = Math.floor(encoded / SERIES_EPISODE_OFFSET);
  const remoteEpisodeId = encoded % SERIES_EPISODE_OFFSET;
  if (!assignmentId || !remoteEpisodeId) return null;

  return { assignmentId, remoteEpisodeId };
}
