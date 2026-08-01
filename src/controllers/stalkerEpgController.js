import db from '../database/db.js';
import { getEpgPrograms, getEpgProgramsForChannels } from '../services/epgService.js';
import { formatStalkerDateTime } from '../utils/stalker.js';
import { value } from './stalkerContentController.js';

const MAX_EPG_PERIOD_HOURS = 168;
const MAX_ARCHIVE_DAYS = 14;
const MAX_EPG_PROGRAMS_PER_CHANNEL = 500;
const MAX_EPG_PROGRAMS_PER_RESPONSE = 20_000;
const EPG_PROGRAMS_PER_HOUR = 4;

export function archiveProgramId(channelId, start, stop) {
  return `stalker_archive_${channelId}_${start}_${stop}`;
}

function mapEpgProgram(channel, program, now) {
  const start = Number(program.start);
  const stop = Number(program.stop);
  const archiveDays = Math.min(Math.max(Number(channel.tv_archive_duration) || 0, 0), MAX_ARCHIVE_DAYS);
  const archived = Boolean(channel.tv_archive) && stop <= now && start >= now - archiveDays * 86400;
  return {
    id: archiveProgramId(channel.id, start, stop),
    ch_id: String(channel.id),
    name: program.title || '',
    descr: program.desc || '',
    time: formatStalkerDateTime(start * 1000),
    time_to: formatStalkerDateTime(stop * 1000),
    start_timestamp: start,
    stop_timestamp: stop,
    duration: Math.max(stop - start, 0),
    mark_archive: archived ? 1 : 0
  };
}

function detailedEpgProgram(channel, program, now) {
  const mapped = mapEpgProgram(channel, program, now);
  return {
    ...mapped,
    real_id: mapped.id,
    t_time: mapped.time.slice(11, 16),
    t_time_to: mapped.time_to.slice(11, 16),
    open: mapped.stop_timestamp < now ? 0 : 1,
    mark_memo: 0,
    mark_rec: 0
  };
}

function getAuthorizedEpgChannel(session, channelId) {
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return null;
  return db.prepare(`
    SELECT uc.id, pc.tv_archive, pc.tv_archive_duration,
           COALESCE(map.epg_channel_id, pc.epg_channel_id) AS epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, session.user_id);
}

function stalkerDateRange(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (start.getFullYear() !== Number(match[1]) || start.getMonth() !== Number(match[2]) - 1 ||
      start.getDate() !== Number(match[3])) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)];
}

export function getSimpleEpg(session, params) {
  const channel = getAuthorizedEpgChannel(session, Number(value(params, 'ch_id')));
  const range = stalkerDateRange(value(params, 'date'));
  const requestedPage = Number(value(params, 'p'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pageSize = 10;
  if (!channel?.epg_id || !range) {
    return { cur_page: page, selected_item: 0, total_items: 0, max_page_items: pageSize, data: [] };
  }

  const now = Math.floor(Date.now() / 1000);
  const programs = getEpgProgramsForChannels(
    new Set([channel.epg_id]),
    range[0],
    range[1],
    MAX_EPG_PROGRAMS_PER_CHANNEL
  ).get(channel.epg_id) || [];
  return {
    cur_page: page,
    selected_item: 0,
    total_items: programs.length,
    max_page_items: pageSize,
    data: programs
      .slice((page - 1) * pageSize, page * pageSize)
      .map(program => detailedEpgProgram(channel, program, now))
  };
}

export function getShortEpg(session, params) {
  const channelId = Number(value(params, 'ch_id') || value(params, 'stream_id'));
  const limit = Math.min(Math.max(Number(value(params, 'size') || value(params, 'limit')) || 5, 1), 50);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return { data: [] };

  const channel = db.prepare(`
    SELECT uc.id, pc.epg_channel_id, pc.tv_archive, pc.tv_archive_duration,
           map.epg_channel_id AS manual_epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, session.user_id);

  const epgId = channel?.manual_epg_id || channel?.epg_channel_id;
  if (!epgId) return { data: [] };

  const now = Math.floor(Date.now() / 1000);
  return { data: [...getEpgPrograms(epgId, limit)].map(program => mapEpgProgram(channel, program, now)) };
}

export function getEpgInfo(session, params) {
  const requestedPeriod = Number(value(params, 'period'));
  const period = Number.isFinite(requestedPeriod) && requestedPeriod > 0
    ? Math.min(Math.floor(requestedPeriod), MAX_EPG_PERIOD_HOURS)
    : MAX_EPG_PERIOD_HOURS;
  const now = Math.floor(Date.now() / 1000);
  const channels = db.prepare(`
    SELECT uc.id, pc.tv_archive, pc.tv_archive_duration,
           COALESCE(map.epg_channel_id, pc.epg_channel_id) AS epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE cat.user_id = ? AND cat.type = 'live' AND cat.is_adult = 0 AND pc.stream_type = 'live'
    ORDER BY uc.id
  `).all(session.user_id);

  const maxArchiveDays = channels.reduce(
    (max, channel) => channel.tv_archive
      ? Math.max(max, Math.min(Number(channel.tv_archive_duration) || 0, MAX_ARCHIVE_DAYS))
      : max,
    0
  );
  const start = now - maxArchiveDays * 86400;
  const end = now + period * 3600;
  const data = Object.fromEntries(channels.map(channel => [String(channel.id), []]));
  const epgIds = new Set(channels
    .map(channel => channel.epg_id)
    .filter(Boolean)
    .sort());
  const programsPerChannel = Math.min(
    MAX_EPG_PROGRAMS_PER_CHANNEL,
    Math.max(1, Math.ceil((period + maxArchiveDays * 24) * EPG_PROGRAMS_PER_HOUR))
  );
  const programsByEpgId = getEpgProgramsForChannels(
    epgIds,
    start,
    end,
    programsPerChannel,
    MAX_EPG_PROGRAMS_PER_RESPONSE
  );
  let totalPrograms = 0;
  let perChannelLimitReached = false;

  for (const channel of channels) {
    if (!channel.epg_id || totalPrograms >= MAX_EPG_PROGRAMS_PER_RESPONSE) continue;
    const available = programsByEpgId.get(channel.epg_id) || [];
    const programs = available.slice(0, Math.min(
      programsPerChannel,
      MAX_EPG_PROGRAMS_PER_RESPONSE - totalPrograms
    ));
    if (available.length >= programsPerChannel) perChannelLimitReached = true;
    data[String(channel.id)] = programs
      .map(program => mapEpgProgram(channel, program, now));
    totalPrograms += programs.length;
  }

  if (totalPrograms >= MAX_EPG_PROGRAMS_PER_RESPONSE || perChannelLimitReached) {
    console.warn(
      'Stalker bulk EPG limit reached: channels=%d programmes=%d max_total=%d max_per_channel=%d',
      channels.length,
      totalPrograms,
      MAX_EPG_PROGRAMS_PER_RESPONSE,
      MAX_EPG_PROGRAMS_PER_CHANNEL
    );
  }

  return { data };
}

