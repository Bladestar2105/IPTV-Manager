import db from '../database/db.js';
import { getEpgProgramsForChannels } from '../services/epgService.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { getBaseUrl, providerSourceKey } from '../utils/helpers.js';
import { MAX_ARCHIVE_DAYS } from '../utils/stalker.js';
import {
  getOrCreateSeriesEpisodeAlias,
  prepareSeriesEpisodeAliases
} from '../utils/seriesEpisodeId.js';
import { value, contentConfig } from './stalkerContentController.js';
import { archiveProgramId } from './stalkerEpgController.js';

function emptyLink() {
  return { id: 0, cmd: '', streamer_id: 0, link_id: 0, load: 0, error: 'nothing_to_play' };
}

function linkResponse(id, url) {
  return {
    id: String(id),
    cmd: `ffmpeg ${url}`,
    streamer_id: 0,
    link_id: String(id),
    load: 0,
    error: ''
  };
}

function commandTarget(command) {
  const target = command.match(/\/stalker\/(itv|vod|series|radio)\/(\d+)(?:\/season\/(\d+))?/i);
  if (target) {
    return { type: target[1].toLowerCase(), id: Number(target[2]), season: Number(target[3]) || 0 };
  }
  const portalCommand = command.match(/^ffrt4:\/\/(itv|vod|series|radio)\/(\d+)(?:\/season\/(\d+))?/i);
  if (portalCommand) {
    return {
      type: portalCommand[1].toLowerCase(),
      id: Number(portalCommand[2]),
      season: Number(portalCommand[3]) || 0
    };
  }
  const legacyLive = command.match(/\/ch\/(\d+)/);
  if (legacyLive) return { type: 'itv', id: Number(legacyLive[1]), season: 0 };
  const mediaFile = command.match(/\/media\/file_(\d+)/);
  if (mediaFile) return { type: 'vod', id: Number(mediaFile[1]), season: 0 };
  return null;
}

function authorizedContent(session, id, type) {
  const config = contentConfig(type);
  if (!config || !Number.isSafeInteger(id) || id <= 0) return null;
  return db.prepare(`
    SELECT uc.id, pc.remote_stream_id, pc.mime_type, p.url AS provider_url
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    JOIN providers p ON p.id = pc.provider_id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = ? AND ${config.streamPredicate}
  `).get(id, session.user_id, config.categoryType);
}

function createSeriesLink(req, session, target, params) {
  const episodeNumber = Number(value(params, 'series'));
  if (!Number.isSafeInteger(target.season) || target.season <= 0 ||
      !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) return emptyLink();

  const series = authorizedContent(session, target.id, 'series');
  if (!series) return emptyLink();
  const sourceKey = providerSourceKey(series.provider_url);
  const episodes = db.prepare(`
    SELECT remote_episode_id, container_extension
    FROM provider_series_episodes
    WHERE source_key = ? AND series_remote_id = ? AND season = ? AND episode_num = ?
  `).all(sourceKey, series.remote_stream_id, target.season, episodeNumber);
  if (episodes.length !== 1) return emptyLink();

  const aliases = prepareSeriesEpisodeAliases(db);
  const alias = getOrCreateSeriesEpisodeAlias(
    aliases,
    series.id,
    sourceKey,
    series.remote_stream_id,
    episodes[0].remote_episode_id
  );
  if (!alias) return emptyLink();

  const extension = normalizeContainerExtension(episodes[0].container_extension);
  const url = `${getBaseUrl(req)}/series/token/auth/${alias}.${extension}?token=${encodeURIComponent(session.token)}`;
  return linkResponse(alias, url);
}

function createArchiveLink(req, session, command) {
  const match = command.trim().match(
    /^(?:auto\s+)?\/media\/stalker_archive_(\d+)_(\d+)_(\d+)\.mpg$/i
  );
  if (!match) return emptyLink();
  const channelId = Number(match[1]);
  const start = Number(match[2]);
  const stop = Number(match[3]);
  if (![channelId, start, stop].every(Number.isSafeInteger) || channelId <= 0 || start <= 0 || stop <= start) {
    return emptyLink();
  }

  const channel = db.prepare(`
    SELECT uc.id, pc.tv_archive, pc.tv_archive_duration,
           COALESCE(map.epg_channel_id, pc.epg_channel_id) AS epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'live' AND pc.stream_type = 'live'
  `).get(channelId, session.user_id);
  const now = Math.floor(Date.now() / 1000);
  const archiveDays = Math.min(Number(channel?.tv_archive_duration) || 0, MAX_ARCHIVE_DAYS);
  if (!channel?.tv_archive || !channel.epg_id || stop > now || start < now - archiveDays * 86400) {
    return emptyLink();
  }

  const programs = getEpgProgramsForChannels(new Set([channel.epg_id]), start - 1, stop + 1, 10)
    .get(channel.epg_id) || [];
  if (!programs.some(program => Number(program.start) === start && Number(program.stop) === stop)) {
    return emptyLink();
  }

  const duration = Math.min(Math.max(Math.ceil((stop - start) / 60), 1), 1440);
  const url = `${getBaseUrl(req)}/timeshift/token/auth/${duration}/epoch-${start}/${channel.id}.ts?token=${encodeURIComponent(session.token)}`;
  return linkResponse(archiveProgramId(channel.id, start, stop), url);
}

export function createLink(req, session, params, requestedType) {
  const command = String(value(params, 'cmd') || '');
  if (requestedType === 'tv_archive') return createArchiveLink(req, session, command);

  const target = commandTarget(command);
  if (!target) return emptyLink();
  const episodeNumber = Number(value(params, 'series'));
  const seriesEpisode = target.type === 'series' &&
    Number.isSafeInteger(target.season) && target.season > 0 &&
    Number.isSafeInteger(episodeNumber) && episodeNumber > 0;
  const typeMatches = requestedType === target.type || (requestedType === 'vod' && seriesEpisode);
  if (!typeMatches) return emptyLink();
  if (target.type === 'series') {
    return createSeriesLink(req, session, target, params);
  }

  const channel = authorizedContent(session, target.id, target.type);
  if (!channel) return emptyLink();

  const baseUrl = getBaseUrl(req);
  let url;
  if (target.type === 'vod') {
    const extension = normalizeContainerExtension(channel.mime_type);
    url = `${baseUrl}/movie/token/auth/${channel.id}.${extension}?token=${encodeURIComponent(session.token)}`;
  } else if (target.type === 'radio') {
    const extension = normalizeContainerExtension(channel.mime_type, 'ts');
    const directAudio = ['mp3', 'aac'].includes(extension);
    url = `${baseUrl}/live/token/auth/${channel.id}.${directAudio ? extension : 'mp3'}?token=${encodeURIComponent(session.token)}${directAudio ? '' : '&transcode=true'}`;
  } else {
    url = `${baseUrl}/live/token/auth/${channel.id}.ts?token=${encodeURIComponent(session.token)}`;
  }
  return linkResponse(channel.id, url);
}
