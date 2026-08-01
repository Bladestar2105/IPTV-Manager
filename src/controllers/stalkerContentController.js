import db from '../database/db.js';
import { syncSeriesEpisode } from '../services/syncService.js';
import { providerSourceKey } from '../utils/helpers.js';

const PAGE_SIZE = 100;

export function value(params, name) {
  const raw = params[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export const CONTENT_TYPES = Object.freeze({
  itv: { categoryType: 'live', streamPredicate: "pc.stream_type = 'live'" },
  vod: { categoryType: 'movie', streamPredicate: "pc.stream_type = 'movie'" },
  series: { categoryType: 'series', streamPredicate: "pc.stream_type = 'series'" },
  radio: { categoryType: 'radio', streamPredicate: "pc.stream_type IN ('radio', 'live')" }
});

export function contentConfig(type) {
  return CONTENT_TYPES[type] || null;
}

export function getCategories(session, type) {
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
    censored: channel.is_adult ? 1 : 0,
    lock: channel.is_adult ? 1 : 0,
    has_files: type === 'vod' ? 1 : 0,
    is_series: type === 'series' ? 1 : 0
  };
  return details;
}

export function getOrderedList(session, params, type = 'itv', { paginated = true, excludeAdult = false } = {}) {
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

export async function getSeriesSeasons(session, params) {
  const seriesId = Number(value(params, 'movie_id'));
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) return [];

  const series = db.prepare(`
    SELECT uc.id, uc.custom_name, pc.remote_stream_id, pc.name, pc.logo,
           pc.plot, pc."cast" AS actors, pc.director, pc.genre, pc.releaseDate,
           pc.rating, pc.provider_id, p.url AS provider_url
    FROM authorized_user_channels uc
    JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    JOIN providers p ON p.id = pc.provider_id
    WHERE uc.id = ? AND cat.user_id = ? AND cat.type = 'series' AND pc.stream_type = 'series'
  `).get(seriesId, session.user_id);
  if (!series) return [];

  const sourceKey = providerSourceKey(series.provider_url);
  const episodeQuery = db.prepare(`
    SELECT remote_episode_id, season, episode_num
    FROM provider_series_episodes
    WHERE source_key = ? AND series_remote_id = ?
    ORDER BY season, episode_num, remote_episode_id
  `);
  let episodes = episodeQuery.all(sourceKey, series.remote_stream_id);
  if (episodes.length === 0) {
    try {
      await syncSeriesEpisode(series.provider_id, series.remote_stream_id);
      episodes = episodeQuery.all(sourceKey, series.remote_stream_id);
    } catch (error) {
      console.warn(`Episode fetch failed for series ${series.remote_stream_id}: ${error.message}`);
    }
  }

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
