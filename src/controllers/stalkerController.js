import crypto from 'crypto';
import db from '../database/db.js';
import { getEpgPrograms, getEpgProgramsForChannels } from '../services/epgService.js';
import { invalidateUserTokens } from '../services/authService.js';
import { isIpAllowedForUser } from '../services/geoIpService.js';
import { decrypt } from '../utils/crypto.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { getBaseUrl, getCookie, providerSourceKey } from '../utils/helpers.js';
import {
  getOrCreateSeriesEpisodeAlias,
  prepareSeriesEpisodeAliases
} from '../utils/seriesEpisodeId.js';
import {
  expiryEpoch,
  formatStalkerDateTime,
  normalizeMac,
  STALKER_TIMEZONE
} from '../utils/stalker.js';

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const ACTIVITY_UPDATE_INTERVAL_SECONDS = 60;
const PAGE_SIZE = 100;
const MAX_EPG_PERIOD_HOURS = 168;
const MAX_ARCHIVE_DAYS = 14;
const MAX_EPG_PROGRAMS_PER_CHANNEL = 500;
const MAX_EPG_PROGRAMS_PER_RESPONSE = 20_000;
const EPG_PROGRAMS_PER_HOUR = 4;

function value(params, name) {
  const raw = params[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function getParams(req) {
  return { ...req.query, ...(req.body || {}) };
}

function getRequestMac(req, params) {
  return normalizeMac(value(params, 'mac') || getCookie(req, 'mac'));
}

function getRequestToken(req, params) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(value(params, 'token') || value(params, 'access_token') || '').trim();
}

function authorizationFailed(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(200).type('text/plain').send('Authorization failed.');
}

function js(res, payload) {
  res.set('Cache-Control', 'no-store');
  return res.json({ js: payload });
}

function findDevice(mac) {
  if (!mac) return null;
  return db.prepare(`
    SELECT sd.*, u.username, u.expiry_date, u.allowed_countries, u.is_active
    FROM stalker_devices sd
    JOIN users u ON u.id = sd.user_id
    WHERE sd.mac = ? COLLATE NOCASE AND sd.enabled = 1 AND u.is_active = 1
  `).get(mac);
}

function createSession(req, params, res) {
  const mac = getRequestMac(req, params);
  const device = findDevice(mac);
  const now = Math.floor(Date.now() / 1000);
  const userExpiry = expiryEpoch(device?.expiry_date);

  if (!device || (userExpiry && userExpiry <= now) || !isIpAllowedForUser(req.ip, device)) {
    return authorizationFailed(res);
  }

  const expiresAt = userExpiry
    ? Math.min(now + SESSION_TTL_SECONDS, userExpiry)
    : now + SESSION_TTL_SECONDS;
  const token = crypto.randomBytes(32).toString('hex');
  const model = String(value(params, 'stb_type') || device.model || '').trim().slice(0, 100) || null;
  const serialNumber = String(value(params, 'sn') || device.serial_number || '').trim().slice(0, 100) || null;
  const deviceUid = String(value(params, 'device_id') || value(params, 'device_id2') || device.device_uid || '').trim().slice(0, 100) || null;

  db.transaction(() => {
    db.prepare('DELETE FROM stalker_sessions WHERE device_id = ? OR expires_at <= ?').run(device.id, now);
    db.prepare(`
      INSERT INTO stalker_sessions (token, device_id, user_id, created_at, expires_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, device.id, device.user_id, now, expiresAt, now);
    db.prepare(`
      UPDATE stalker_devices
      SET serial_number = ?, device_uid = ?, model = ?, last_ip = ?, last_seen = ?
      WHERE id = ?
    `).run(serialNumber, deviceUid, model, req.ip || null, now, device.id);
  })();
  invalidateUserTokens(device.user_id);

  return js(res, {
    token,
    random: crypto.randomBytes(20).toString('hex')
  });
}

function getSession(req, params) {
  const token = getRequestToken(req, params);
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const session = db.prepare(`
    SELECT ss.token, ss.expires_at, ss.last_seen AS session_last_seen,
           sd.id AS device_id, sd.mac, sd.model, sd.serial_number, sd.device_uid,
           sd.last_seen AS device_last_seen, sd.parental_pin_encrypted,
           u.id AS user_id, u.username, u.expiry_date, u.allowed_countries, u.is_active
    FROM stalker_sessions ss
    JOIN stalker_devices sd ON sd.id = ss.device_id AND sd.user_id = ss.user_id
    JOIN users u ON u.id = ss.user_id
    WHERE ss.token = ? AND ss.expires_at > ? AND sd.enabled = 1 AND u.is_active = 1
  `).get(token, now);

  if (!session) return null;
  const requestedMac = getRequestMac(req, params);
  if (requestedMac && requestedMac !== session.mac) return null;
  const userExpiry = expiryEpoch(session.expiry_date);
  if ((userExpiry && userExpiry <= now) || !isIpAllowedForUser(req.ip, session)) return null;

  const oldestActivity = Math.min(
    Number(session.session_last_seen) || 0,
    Number(session.device_last_seen) || 0
  );
  if (now - oldestActivity >= ACTIVITY_UPDATE_INTERVAL_SECONDS) {
    db.transaction(() => {
      db.prepare('UPDATE stalker_sessions SET last_seen = ? WHERE token = ?').run(now, token);
      db.prepare('UPDATE stalker_devices SET last_ip = ?, last_seen = ? WHERE id = ?').run(req.ip || null, now, session.device_id);
    })();
  }
  return session;
}

function profile(session) {
  const parentalPin = decrypt(session.parental_pin_encrypted) || '';
  return {
    id: String(session.user_id),
    name: session.username,
    login: session.username,
    ls: String(session.user_id),
    mac: session.mac,
    status: 1,
    auth_access: 0,
    stb_type: session.model || '',
    sn: session.serial_number || '',
    device_id: session.device_uid || '',
    hd: 1,
    tv_quality: 'high',
    additional_services_on: '1',
    parent_password: /^\d{4,8}$/.test(parentalPin) ? parentalPin : '',
    settings_password: '',
    timezone: STALKER_TIMEZONE,
    default_timezone: STALKER_TIMEZONE,
    show_tv_channel_logo: 1,
    enable_buffering_indication: 1,
    expires_at: session.expires_at
  };
}

const CONTENT_TYPES = Object.freeze({
  itv: { categoryType: 'live', streamPredicate: "pc.stream_type = 'live'" },
  vod: { categoryType: 'movie', streamPredicate: "pc.stream_type = 'movie'" },
  series: { categoryType: 'series', streamPredicate: "pc.stream_type = 'series'" },
  radio: { categoryType: 'radio', streamPredicate: "pc.stream_type IN ('radio', 'live')" }
});

function contentConfig(type) {
  return CONTENT_TYPES[type] || null;
}

function getCategories(session, type) {
  const config = contentConfig(type);
  if (!config) return [];

  const categories = db.prepare(`
    SELECT cat.id, cat.name, cat.is_adult
    FROM user_categories cat
    WHERE cat.user_id = ? AND cat.type = ?
      AND EXISTS (
        SELECT 1
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE uc.user_category_id = cat.id AND ${config.streamPredicate}
      )
    ORDER BY cat.sort_order, cat.name
  `).all(session.user_id, config.categoryType);

  return [
    { id: '*', title: 'All', alias: 'all', censored: 0 },
    ...categories.map(category => ({
      id: String(category.id),
      title: category.name,
      alias: String(category.id),
      censored: category.is_adult ? 1 : 0
    }))
  ];
}

function categoryFilter(params) {
  const requested = ['genre', 'category']
    .map(name => value(params, name))
    .filter(raw => raw !== undefined && raw !== null && String(raw).trim() !== '')
    .map(raw => String(raw).trim());

  const numeric = requested.find(raw => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0);
  if (numeric) return { id: Number(numeric), invalid: false };
  if (requested.length === 0 || requested.every(raw => raw === '*' || raw === '0')) {
    return { id: null, invalid: false };
  }
  return { id: null, invalid: true };
}

function pageNumber(params) {
  const requestedPage = Number(value(params, 'p'));
  if (!Number.isSafeInteger(requestedPage) || requestedPage <= 1) return 1;
  return Math.min(requestedPage, 1_000_000);
}

function searchFilter(params) {
  const search = String(value(params, 'search') || '').trim().slice(0, 200);
  if (!search) return null;
  return `%${search.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

function emptyOrderedList(page, paginated) {
  return {
    total_items: '0',
    max_page_items: paginated ? PAGE_SIZE : 0,
    selected_item: 0,
    cur_page: page,
    total_pages: 0,
    data: []
  };
}

function mapContentItem(type, channel, number) {
  const id = String(channel.id);
  const name = channel.custom_name || channel.name;
  const common = {
    id,
    stream_id: id,
    name,
    o_name: name,
    title: name,
    number: String(number),
    category_id: String(channel.category_id),
    logo: channel.logo || '',
    fav: 0
  };

  if (type === 'itv') {
    return {
      ...common,
      tv_genre_id: String(channel.category_id),
      xmltv_id: channel.manual_epg_id || channel.epg_channel_id || '',
      cmd: `ffmpeg http://localhost/stalker/itv/${id}`,
      censored: channel.is_adult ? 1 : 0,
      use_http_tmp_link: 1,
      use_load_balancing: 0,
      enable_tv_archive: channel.tv_archive ? 1 : 0,
      allow_tv_archive: channel.tv_archive ? 1 : 0,
      tv_archive_duration: Number(channel.tv_archive_duration) || 0,
      open: 1
    };
  }

  if (type === 'radio') {
    return {
      ...common,
      tv_genre_id: String(channel.category_id),
      cmd: `ffrt4://radio/${id}`,
      radio: true,
      use_http_tmp_link: 1,
      open: 1
    };
  }

  const details = {
    ...common,
    cmd: `ffmpeg http://localhost/stalker/${type}/${id}`,
    screenshot_uri: channel.logo || '',
    cover: channel.logo || '',
    description: channel.plot || '',
    actors: channel.actors || '',
    director: channel.director || '',
    year: channel.releaseDate ? String(channel.releaseDate).slice(0, 4) : '',
    releasedate: channel.releaseDate || '',
    genre: channel.genre || '',
    genres_str: channel.genre || '',
    rating_imdb: channel.rating || '',
    rating_kinopoisk: channel.rating || '',
    has_files: type === 'vod' ? 1 : 0,
    is_series: 0
  };
  return details;
}

function getOrderedList(session, params, type = 'itv', { paginated = true, excludeAdult = false } = {}) {
  const config = contentConfig(type);
  const filter = categoryFilter(params);
  const page = paginated ? pageNumber(params) : 1;
  if (!config || filter.invalid) return emptyOrderedList(page, paginated);

  const offset = paginated ? (page - 1) * PAGE_SIZE : 0;
  const search = searchFilter(params);
  const clauses = [
    'cat.user_id = ?',
    'cat.type = ?',
    config.streamPredicate
  ];
  const bindings = [session.user_id, config.categoryType];

  if (filter.id) {
    clauses.push('cat.id = ?');
    bindings.push(filter.id);
  } else {
    clauses.push('cat.is_adult = 0');
  }
  if (excludeAdult) clauses.push('cat.is_adult = 0');
  if (search) {
    clauses.push("COALESCE(NULLIF(uc.custom_name, ''), pc.name) LIKE ? ESCAPE '\\' COLLATE NOCASE");
    bindings.push(search);
  }

  const where = clauses.join(' AND ');
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    WHERE ${where}
  `).get(...bindings).count;

  const channels = db.prepare(`
    SELECT uc.id, uc.custom_name, uc.sort_order,
           cat.id AS category_id, cat.is_adult,
           pc.remote_stream_id, pc.name, pc.logo, pc.epg_channel_id,
           pc.tv_archive, pc.tv_archive_duration, pc.mime_type,
           pc.rating, pc.plot, pc."cast" AS actors, pc.director,
           pc.genre, pc.releaseDate,
           map.epg_channel_id AS manual_epg_id
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE ${where}
    ORDER BY cat.sort_order, uc.sort_order, pc.original_sort_order, pc.name
    ${paginated ? 'LIMIT ? OFFSET ?' : ''}
  `).all(...bindings, ...(paginated ? [PAGE_SIZE, offset] : []));

  return {
    total_items: String(total),
    max_page_items: paginated ? PAGE_SIZE : total,
    selected_item: 0,
    cur_page: page,
    total_pages: paginated ? Math.ceil(total / PAGE_SIZE) : total > 0 ? 1 : 0,
    data: channels.map((channel, index) => mapContentItem(type, channel, offset + index + 1))
  };
}

function getSeriesSeasons(session, params) {
  const seriesId = Number(value(params, 'movie_id'));
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) return [];

  const series = db.prepare(`
    SELECT uc.id, uc.custom_name, pc.remote_stream_id, pc.name, pc.logo,
           pc.plot, pc."cast" AS actors, pc.director, pc.genre, pc.releaseDate,
           pc.rating, p.url AS provider_url
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    JOIN providers p ON p.id = pc.provider_id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'series' AND pc.stream_type = 'series'
  `).get(seriesId, session.user_id);
  if (!series) return [];

  const sourceKey = providerSourceKey(series.provider_url);
  const episodes = db.prepare(`
    SELECT remote_episode_id, season, episode_num
    FROM provider_series_episodes
    WHERE source_key = ? AND series_remote_id = ?
    ORDER BY season, episode_num, remote_episode_id
  `).all(sourceKey, series.remote_stream_id);

  const seasons = new Map();
  for (const episode of episodes) {
    const seasonNumber = Number(episode.season);
    const episodeNumber = Number(episode.episode_num);
    if (!Number.isSafeInteger(seasonNumber) || seasonNumber <= 0 ||
        !Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) continue;
    if (!seasons.has(seasonNumber)) seasons.set(seasonNumber, new Map());
    const seasonEpisodes = seasons.get(seasonNumber);
    seasonEpisodes.set(episodeNumber, seasonEpisodes.has(episodeNumber) ? null : episode);
  }

  const displayName = series.custom_name || series.name;
  return [...seasons.entries()].map(([seasonNumber, episodeMap]) => ({
    id: `${series.id}-s${seasonNumber}`,
    name: `Season ${seasonNumber}`,
    cmd: `ffmpeg http://localhost/stalker/series/${series.id}/season/${seasonNumber}`,
    description: series.plot || '',
    director: series.director || '',
    actors: series.actors || '',
    year: series.releaseDate ? String(series.releaseDate).slice(0, 4) : '',
    genres_str: series.genre || '',
    age: '',
    rating_imdb: series.rating || '',
    rating_kinopoisk: series.rating || '',
    screenshot_uri: series.logo || '',
    added: '',
    title: displayName,
    series: [...episodeMap.entries()]
      .filter(([, episode]) => episode)
      .map(([episodeNumber]) => String(episodeNumber))
  })).filter(season => season.series.length > 0);
}

function archiveProgramId(channelId, start, stop) {
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

function getSimpleEpg(session, params) {
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

function getShortEpg(session, params) {
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

function getEpgInfo(session, params) {
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

function formatTimeshiftStart(timestamp) {
  const [date, time] = formatStalkerDateTime(timestamp * 1000).split(' ');
  return `${date}:${time.slice(0, 5).replace(':', '-')}`;
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
  const url = `${getBaseUrl(req)}/timeshift/token/auth/${duration}/${formatTimeshiftStart(start)}/${channel.id}.ts?token=${encodeURIComponent(session.token)}`;
  return linkResponse(archiveProgramId(channel.id, start, stop), url);
}

function createLink(req, session, params, requestedType) {
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

function mainInfo(session) {
  return {
    phone: '',
    tariff_plan: '',
    account_balance: '',
    end_date: session.expiry_date || '',
    account_info: {
      expire_date: session.expiry_date ? String(expiryEpoch(session.expiry_date) || '') : ''
    }
  };
}

export function portal(req, res) {
  const params = getParams(req);
  const type = String(value(params, 'type') || '').toLowerCase();
  const action = String(value(params, 'action') || '').toLowerCase();

  if (type === 'stb' && action === 'handshake') {
    return createSession(req, params, res);
  }

  const session = getSession(req, params);
  if (!session) return authorizationFailed(res);

  if (type === 'stb') {
    if (action === 'get_profile') return js(res, profile(session));
    if (action === 'do_auth') return js(res, true);
    if (action === 'get_modules') {
      return js(res, {
        all_modules: ['tv', 'vclub', 'series', 'radio', 'tv_archive'],
        switchable_modules: [],
        disabled_modules: [],
        restricted_modules: [],
        template: 'default'
      });
    }
    if (action === 'get_localization') return js(res, {});
    if (action === 'get_main_info') return js(res, mainInfo(session));
    if (action === 'get_time') return js(res, { time: formatStalkerDateTime(new Date()) });
  }

  if (type === 'account_info' && action === 'get_main_info') {
    return js(res, mainInfo(session));
  }

  if (type === 'epg' && action === 'get_simple_data_table') {
    return js(res, getSimpleEpg(session, params));
  }

  const config = contentConfig(type);
  if (config) {
    if (['get_categories', 'get_genres', 'get_genres_itv', 'get_genres_vod'].includes(action)) {
      return js(res, getCategories(session, type));
    }
    if (action === 'get_ordered_list') {
      if (type === 'series' && value(params, 'movie_id')) {
        return js(res, getSeriesSeasons(session, params));
      }
      return js(res, getOrderedList(session, params, type));
    }
    if (type === 'itv' && action === 'get_all_channels') {
      return js(res, getOrderedList(session, params, type, { paginated: false, excludeAdult: true }));
    }
    if (type === 'itv' && action === 'get_short_epg') return js(res, getShortEpg(session, params));
    if (type === 'itv' && action === 'get_epg_info') return js(res, getEpgInfo(session, params));
    if (action === 'create_link') return js(res, createLink(req, session, params, type));
  }

  if (type === 'tv_archive' && action === 'create_link') {
    return js(res, createLink(req, session, params, type));
  }

  return js(res, {});
}
