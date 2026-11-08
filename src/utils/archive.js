export function getArchiveDays(channel) {
  const days = Number(channel?.tv_archive_duration);
  return Number(channel?.tv_archive) === 1 && Number.isSafeInteger(days) && days > 0 ? days : 0;
}

export function isArchiveProgram(channel, program, now = Date.now() / 1000) {
  const days = getArchiveDays(channel);
  const start = Number(program?.start);
  const stop = Number(program?.stop);
  return days > 0 && Number.isFinite(start) && Number.isFinite(stop) && stop > start
    && stop <= now && start >= now - days * 86400;
}
