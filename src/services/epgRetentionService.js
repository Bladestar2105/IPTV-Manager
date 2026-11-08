import db from '../database/db.js';

export function getProviderEpgChannels(providerId, database = db) {
  return database.prepare(`
    SELECT DISTINCT COALESCE(NULLIF(map.epg_channel_id, ''), pc.epg_channel_id) AS epg_channel_id,
      pc.name, pc.logo
    FROM provider_channels pc
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE pc.provider_id = ?
      AND COALESCE(NULLIF(map.epg_channel_id, ''), pc.epg_channel_id, '') != ''
  `).all(providerId);
}

export function getEpgRetentionDays(minimumDays = 7, database = db) {
  // EPG IDs can be shared by providers and custom sources, so retain the longest advertised archive.
  const row = database.prepare(`
    SELECT MAX(tv_archive_duration) AS archive_days FROM provider_channels
    WHERE tv_archive = 1 AND tv_archive_duration > 0
      AND tv_archive_duration <= 9007199254740991
      AND tv_archive_duration = CAST(tv_archive_duration AS INTEGER)
  `).get();
  const baseline = Number.isSafeInteger(minimumDays) && minimumDays > 0 ? minimumDays : 7;
  const advertised = Number(row?.archive_days);
  return Math.max(baseline, Number.isSafeInteger(advertised) && advertised > 0 ? advertised : 0);
}
