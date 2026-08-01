import zlib from 'zlib';
import db, { openDbConnection } from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';
import { getEpgXmlForChannels } from '../services/epgService.js';
import { channelsJsonCache } from '../services/cacheService.js';
import { getBaseUrl, providerSourceKey } from '../utils/helpers.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { getEpgLogo, loadEpgLogosCache } from '../services/logoResolver.js';
import {
  getOrCreateSeriesEpisodeAlias,
  prepareSeriesEpisodeAliases
} from '../utils/seriesEpisodeId.js';

import {
  appendAllowedChannelFilter,
  getShareScope,
  sanitizeMetadata,
  sanitizeM3uName,
  sanitizeM3uTag,
  wantsGzipResponse
} from './xtreamControllerUtils.js';
export * from './xtreamControllerUtils.js';
export { playerApi } from './xtreamPlayerApiController.js';

export const getPlaylist = async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const type = (req.query.type || 'm3u').trim();
    const output = (req.query.output || 'ts').trim();

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);
    const shareScope = getShareScope(user);
    if (shareScope.isExpired) return res.sendStatus(403);

    let query = `
      SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.name, pc.logo, pc.epg_channel_id, pc.stream_type, pc.mime_type,
        pc.tv_archive,
        pc.tv_archive_duration,
        pc.provider_id, pc.remote_stream_id,
             cat.name as category_name, map.epg_channel_id as manual_epg_id
      FROM user_categories cat
      JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ? AND uc.is_hidden = 0`;
    let params = [user.id];
    ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));
    query += `
      -- ⚡ Bolt: Optimize ORDER BY clause using composite index to remove temporary B-tree allocation
      ORDER BY cat.sort_order ASC, uc.sort_order ASC
    `;
    const stmt = db.prepare(query);

    const baseUrl = getBaseUrl(req);
    let header = '#EXTM3U';
    const tokenParam = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';

    if (type === 'm3u_plus') {
      if (shareScope.isShareGuest && tokenParam) {
        header += ` url-tvg="${baseUrl}/xmltv.php${tokenParam}"`;
      } else {
        header += ` url-tvg="${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}"`;
      }
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="playlist.m3u"`);

    // ⚡ Bolt: Stream playlist generation to reduce V8 memory pressure for massive lists
    // 🎯 Why: Storing 50,000+ channel strings in a massive array before joining them exhausts heap memory
    // 📊 Impact: Significantly lowers RAM usage and event loop blocking overhead
    let buffer = header + '\n';
    const FLUSH_LIMIT = 65536;

    // ⚡ Bolt: Pre-encode credentials and pre-construct URL prefixes outside of the tight loop.
    // 🎯 Why: Calling encodeURIComponent and interpolating complex templates 50,000+ times per request wastes massive CPU cycles.
    // 📊 Impact: Significantly speeds up playlist generation loop and reduces V8 garbage collection pressure.
    const useTokenAuth = shareScope.isShareGuest && !!req.query.token;
    const encUser = encodeURIComponent(username);
    const encPass = encodeURIComponent(password);
    const livePrefix = useTokenAuth ? `${baseUrl}/live/token/auth/` : `${baseUrl}/live/${encUser}/${encPass}/`;
    const moviePrefix = useTokenAuth ? `${baseUrl}/movie/token/auth/` : `${baseUrl}/movie/${encUser}/${encPass}/`;
    const seriesPrefix = useTokenAuth ? `${baseUrl}/series/token/auth/` : `${baseUrl}/series/${encUser}/${encPass}/`;

    // Episodes synced from the provider (see syncSeriesEpisodes). Series are
    // expanded into one entry per episode like a native Xtream panel does.
    // Episodes are stored per upstream panel (source_key), shared between
    // provider rows that point at the same panel with different credentials.
    const episodesStmt = db.prepare(`
      SELECT remote_episode_id, season, episode_num, container_extension, logo
      FROM provider_series_episodes
      WHERE source_key = ? AND series_remote_id = ?
      ORDER BY season ASC, episode_num ASC, remote_episode_id ASC
    `);
    const seriesEpisodesCache = new Map();
    const episodeAliasDb = openDbConnection();
    const episodeAliases = prepareSeriesEpisodeAliases(episodeAliasDb);
    const sourceKeyByProviderId = new Map(
      db.prepare('SELECT id, url FROM providers').all().map(p => [p.id, providerSourceKey(p.url)])
    );
    // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
    // 🎯 Why: Loading 50,000+ channel objects into V8 memory at once can cause memory spikes and block the event loop.
    // 📊 Impact: Drastically reduces peak memory usage and improves response time for massive playlists.
    try {
    for (const ch of stmt.iterate(...params)) {
      const epgId = ch.manual_epg_id || ch.epg_channel_id || '';
      const logo = ch.logo || '';
      const group = ch.category_name || '';
      const name = ch.custom_name ? ch.custom_name : (ch.name || 'Unknown');
      const streamId = ch.user_channel_id;

      const safeName = sanitizeM3uName(name);
      const safeLogo = sanitizeM3uTag(logo);
      const safeGroup = sanitizeM3uTag(group);
      const groupId = ch.user_category_id || '';

      let finalName = String(name);
      if (finalName.indexOf('\n') !== -1 || finalName.indexOf('\r') !== -1) {
          finalName = finalName.replace(/[\r\n]+/g, ' ');
      }
      finalName = finalName.trim();

      if (ch.stream_type === 'series') {
        const sourceKey = sourceKeyByProviderId.get(ch.provider_id) || '';
        let episodesBySeries = seriesEpisodesCache.get(sourceKey);
        if (!episodesBySeries) {
          episodesBySeries = new Map();
          seriesEpisodesCache.set(sourceKey, episodesBySeries);
        }
        let episodes = episodesBySeries.get(ch.remote_stream_id);
        if (episodes === undefined) {
          episodes = episodesStmt.all(sourceKey, ch.remote_stream_id);
          episodesBySeries.set(ch.remote_stream_id, episodes);
        }
        if (episodes.length > 0) {
          for (const ep of episodes) {
            const epCode = `S${String(ep.season || 0).padStart(2, '0')} E${String(ep.episode_num || 0).padStart(2, '0')}`;
            const epName = `${finalName} ${epCode}`;
            const epLogo = ep.logo ? sanitizeM3uTag(ep.logo) : safeLogo;
            const episodeId = getOrCreateSeriesEpisodeAlias(
              episodeAliases,
              ch.user_channel_id,
              sourceKey,
              ch.remote_stream_id,
              ep.remote_episode_id
            );
            if (!episodeId) continue;
            let episodeUrl = seriesPrefix + episodeId + '.' + normalizeContainerExtension(ep.container_extension);
            if (useTokenAuth) {
              episodeUrl += tokenParam;
            }

            if (type === 'm3u_plus') {
              buffer += `#EXTINF:-1 tvg-id="" tvg-name="${sanitizeM3uName(epName)}" tvg-logo="${epLogo}" group-id="${groupId}" group-title="${safeGroup}",${epName}\n`;
            } else {
              buffer += `#EXTINF:-1,${epName}\n`;
            }
            buffer += episodeUrl + '\n';

            if (buffer.length >= FLUSH_LIMIT) {
                res.write(buffer);
                buffer = '';
            }
          }
          continue;
        }
        // Unsynchronized series have no playable episode identifier yet.
        continue;
      }

      let streamUrl;
      if (ch.stream_type === 'movie') {
         streamUrl = moviePrefix + streamId + '.' + normalizeContainerExtension(ch.mime_type);
      } else {
         streamUrl = livePrefix + streamId + '.' + (output === 'hls' ? 'm3u8' : 'ts');
      }
      if (useTokenAuth) {
        streamUrl += tokenParam;
      }

      if (type === 'm3u_plus') {
        buffer += `#EXTINF:-1 tvg-id="${epgId}" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-id="${groupId}" group-title="${safeGroup}",${finalName}\n`;
      } else {
        buffer += `#EXTINF:-1,${finalName}\n`;
      }
      buffer += streamUrl + '\n';

      if (buffer.length >= FLUSH_LIMIT) {
          res.write(buffer);
          buffer = '';
      }
    }
    } finally {
      episodeAliasDb.close();
    }

    if (buffer.length > 0) {
        res.write(buffer);
    }
    res.end();

  } catch (e) {
    console.error('get.php error:', e);
    res.sendStatus(500);
  }
};

export const xmltv = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);
    const shareScope = getShareScope(user);
    if (shareScope.isExpired) return res.sendStatus(403);

    // Get allowed EPG IDs for this user
    const allowedIds = new Set();
    let query = `
        SELECT DISTINCT COALESCE(map.epg_channel_id, pc.epg_channel_id) as epg_id
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND uc.is_hidden = 0
        AND (map.epg_channel_id IS NOT NULL OR pc.epg_channel_id IS NOT NULL)
    `;
    let params = [user.id];
    ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));
    const stmt = db.prepare(query);

    // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
    // 🎯 Why: Using .all().map() creates massive intermediate arrays in V8 memory.
    // 📊 Impact: Significantly reduces peak garbage collection pressure and memory usage for large EPGs.
    for (const r of stmt.iterate(...params)) {
        if (r.epg_id) allowedIds.add(r.epg_id);
    }

    const useGzip = wantsGzipResponse(req);
    let output = res;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    if (useGzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      output = zlib.createGzip();
      output.pipe(res);
    }

    output.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

    // Use the generator to stream content
    for await (const chunk of getEpgXmlForChannels(allowedIds)) {
        output.write(chunk);
    }

    output.end('</tv>');

  } catch (e) {
    console.error('xmltv error:', e.message);
    if (!res.headersSent) res.status(500);
    res.end('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
};

export const playerChannelsJson = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const tokenParam = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
    const host = getBaseUrl(req);
    // Cache key incorporates whether it's a guest, the user ID, the host string, and token
    const cacheKey = `${user.is_share_guest ? 'guest' : 'user'}_${user.id}_${host}_${tokenParam}`;

    if (channelsJsonCache.has(cacheKey)) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(channelsJsonCache.get(cacheKey));
    }

    // Load EPG logos cache for logo resolution
    loadEpgLogosCache();

    const stmt = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        uc.custom_name,
        uc.user_category_id,
        pc.name,
        pc.logo,
        pc.epg_channel_id,
        pc.remote_stream_id,
        pc.provider_id,
        pc.stream_type,
        pc.tv_archive,
        pc.tv_archive_duration,
        pc.mime_type,
        json_extract(pc.metadata, '$.drm.license_type') as drm_license_type,
        json_extract(pc.metadata, '$.drm.license_key') as drm_license_key,
        pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.rating, pc.episode_run_time,
        cat.name as category_name,
        map.epg_channel_id as manual_epg_id,
        p.use_mapped_epg_icon,
        p.url as provider_url
      FROM user_categories cat
      JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      LEFT JOIN providers p ON p.id = pc.provider_id
      WHERE cat.user_id = ? AND uc.is_hidden = 0
      -- ⚡ Bolt: Optimize ORDER BY clause using composite index to remove temporary B-tree allocation
      ORDER BY cat.sort_order ASC, uc.sort_order ASC
    `);

    let allowedSet = null;
    let isExpired = false;

    if (user.is_share_guest) {
        allowedSet = new Set(user.allowed_channels || []);
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) {
             isExpired = true;
        }
    }

    // ⚡ Bolt: Build JSON string iteratively instead of allocating a massive intermediate array
    // 🎯 Why: JSON.stringify on an array of 50,000+ objects consumes significant V8 heap memory and blocks event loop.
    // 📊 Impact: Significantly lowers RAM usage and speeds up response generation for player JSON payload.
    let jsonOutput = '[';
    let isFirst = true;
    const appendItem = (item, ch) => {
      if (ch.stream_type === 'movie' || ch.stream_type === 'series') {
        if (ch.plot) item.plot = ch.plot;
        if (ch.cast) item.cast = ch.cast;
        if (ch.director) item.director = ch.director;
        if (ch.genre) item.genre = ch.genre;
        if (ch.releaseDate) item.releaseDate = ch.releaseDate;
        if (ch.rating) item.rating = ch.rating;
        if (ch.episode_run_time) item.duration = ch.episode_run_time;
      }

      if (ch.drm_license_type || ch.drm_license_key) {
        item.drm = {};
        if (ch.drm_license_type) item.drm.license_type = ch.drm_license_type;
        if (ch.drm_license_key) item.drm.license_key = ch.drm_license_key;
      }

      if (!isFirst) jsonOutput += ',';
      jsonOutput += JSON.stringify(item);
      isFirst = false;
    };

    if (!isExpired) {
        // ⚡ Bolt: Pre-construct URL prefixes outside of the tight loop.
        const livePrefix = `${host}/live/token/auth/`;
        const liveMpdPrefix = `${host}/live/mpd/token/auth/`;
        const moviePrefix = `${host}/movie/token/auth/`;
        const seriesPrefix = `${host}/series/token/auth/`;
        const episodesStmt = db.prepare(`
          SELECT remote_episode_id, season, episode_num, container_extension, logo
          FROM provider_series_episodes
          WHERE source_key = ? AND series_remote_id = ?
          ORDER BY season ASC, episode_num ASC, remote_episode_id ASC
        `);
        const seriesEpisodesCache = new Map();
        const episodeAliasDb = openDbConnection();
        const episodeAliases = prepareSeriesEpisodeAliases(episodeAliasDb);

        try {
        for (const ch of stmt.iterate(user.id)) {
          if (allowedSet && !allowedSet.has(ch.user_channel_id)) continue;

          const group = ch.category_name || 'Uncategorized';
          const epgId = ch.manual_epg_id || ch.epg_channel_id;
          let logo = ch.logo || '';
          if (ch.use_mapped_epg_icon && epgId) {
            const epgLogo = getEpgLogo(epgId);
            if (epgLogo) logo = epgLogo;
          }
          let name = String(ch.custom_name ? ch.custom_name : (ch.name || 'Unknown'));
          if (name.indexOf('\n') !== -1 || name.indexOf('\r') !== -1) {
              name = name.replace(/[\r\n]+/g, ' ');
          }
          name = name.trim();

          const containerExtension = normalizeContainerExtension(
            ch.mime_type,
            ch.stream_type === 'live' ? 'ts' : 'mp4'
          );
          const isDashStream = containerExtension === 'mpd';
          let streamUrl;
          let type = 'live';

          if (ch.stream_type === 'movie') {
             type = 'movie';
             streamUrl = moviePrefix + ch.user_channel_id + '.' + containerExtension + tokenParam;
          } else if (ch.stream_type === 'series') {
             const sourceKey = providerSourceKey(ch.provider_url);
             let episodesBySeries = seriesEpisodesCache.get(sourceKey);
             if (!episodesBySeries) {
               episodesBySeries = new Map();
               seriesEpisodesCache.set(sourceKey, episodesBySeries);
             }
             let episodes = episodesBySeries.get(ch.remote_stream_id);
             if (episodes === undefined) {
               episodes = episodesStmt.all(sourceKey, ch.remote_stream_id);
               episodesBySeries.set(ch.remote_stream_id, episodes);
             }
             for (const ep of episodes) {
               const episodeId = getOrCreateSeriesEpisodeAlias(
                 episodeAliases,
                 ch.user_channel_id,
                 sourceKey,
                 ch.remote_stream_id,
                 ep.remote_episode_id
               );
               if (!episodeId) continue;
               const extension = normalizeContainerExtension(ep.container_extension);
               const episodeCode = `S${String(ep.season || 0).padStart(2, '0')} E${String(ep.episode_num || 0).padStart(2, '0')}`;
               appendItem({
                 name: `${name} ${episodeCode}`,
                 group,
                 logo: ep.logo || logo,
                 epg_id: epgId,
                 url: seriesPrefix + episodeId + '.' + extension + tokenParam,
                 type: 'series',
                 container_extension: extension,
                 tv_archive: 0,
                 tv_archive_duration: 0
               }, ch);
             }
             continue;
          } else {
             if (isDashStream) {
                 streamUrl = liveMpdPrefix + ch.user_channel_id + '/manifest.mpd' + tokenParam;
             } else {
                 streamUrl = livePrefix + ch.user_channel_id + '.ts' + tokenParam;
             }
          }

          const item = {
            name,
            group,
            logo,
            epg_id: epgId,
            url: streamUrl,
            type,
            container_extension: containerExtension || (type === 'live' ? 'ts' : 'mp4'),
            tv_archive: ch.tv_archive || 0,
            tv_archive_duration: ch.tv_archive_duration || 0
          };

          appendItem(item, ch);
        }
        } finally {
          episodeAliasDb.close();
        }
    }
    jsonOutput += ']';

    channelsJsonCache.set(cacheKey, jsonOutput);

    res.setHeader('Content-Type', 'application/json');
    res.send(jsonOutput);

  } catch (e) {
    console.error('Channels JSON generation error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const playerPlaylist = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.status(401).send('Unauthorized');

    const stmt = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        uc.user_category_id,
        pc.name,
        pc.logo,
        pc.epg_channel_id,
        pc.remote_stream_id,
        pc.stream_type,
        pc.tv_archive,
        pc.tv_archive_duration,
        pc.mime_type,
        json_extract(pc.metadata, '$.drm.license_type') as drm_license_type,
        json_extract(pc.metadata, '$.drm.license_key') as drm_license_key,
        pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.rating, pc.episode_run_time,
        cat.name as category_name,
        map.epg_channel_id as manual_epg_id
      FROM user_categories cat
      JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ? AND pc.stream_type != 'series' AND uc.is_hidden = 0
      -- ⚡ Bolt: Optimize ORDER BY clause using composite index to remove temporary B-tree allocation
      ORDER BY cat.sort_order ASC, uc.sort_order ASC
    `);

    let allowedSet = null;
    let isExpired = false;

    if (user.is_share_guest) {
        allowedSet = new Set(user.allowed_channels || []);
        // Also check start/end time validity for the playlist itself (though stream controller enforces it too)
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) {
             isExpired = true;
        }
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');

    // ⚡ Bolt: Stream playlist generation to reduce V8 memory pressure for massive lists
    // 🎯 Why: Storing 50,000+ channel strings in a massive array before joining them exhausts heap memory
    // 📊 Impact: Significantly lowers RAM usage and event loop blocking overhead
    let buffer = '#EXTM3U\n';
    const FLUSH_LIMIT = 65536;

    const host = getBaseUrl(req);
    const tokenParam = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';

    if (!isExpired) {
        // ⚡ Bolt: Pre-construct URL prefixes outside of the tight loop.
        // 🎯 Why: Generating the prefix repeatedly for 50,000+ items consumes unnecessary CPU cycles.
        // 📊 Impact: Optimizes the M3U playlist generation loop.
        const livePrefix = `${host}/live/token/auth/`;
        const liveMpdPrefix = `${host}/live/mpd/token/auth/`;
        const moviePrefix = `${host}/movie/token/auth/`;

        // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
        // 🎯 Why: Loading 50,000+ channel objects into V8 memory at once can cause memory spikes and block the event loop.
        // 📊 Impact: Drastically reduces peak memory usage and improves response time for massive playlists.
        for (const ch of stmt.iterate(user.id)) {
          if (allowedSet && !allowedSet.has(ch.user_channel_id)) continue;

          const group = ch.category_name || 'Uncategorized';
      const logo = ch.logo || '';
      const name = ch.name || 'Unknown';

      let streamUrl;
      const containerExtension = normalizeContainerExtension(
        ch.mime_type,
        ch.stream_type === 'live' ? 'ts' : 'mp4'
      );
      if (ch.stream_type === 'movie') {
         streamUrl = moviePrefix + ch.user_channel_id + '.' + containerExtension + tokenParam;
      } else {
         if (containerExtension === 'mpd') {
             streamUrl = liveMpdPrefix + ch.user_channel_id + '/manifest.mpd' + tokenParam;
         } else {
             streamUrl = livePrefix + ch.user_channel_id + '.ts' + tokenParam;
         }
      }

      const safeGroup = sanitizeM3uTag(group);
      const safeLogo = sanitizeM3uTag(logo);
      const safeName = sanitizeM3uName(name);
      const epgId = ch.manual_epg_id || ch.epg_channel_id || '';

      const extraParts = [];
      if (ch.stream_type === 'movie' || ch.stream_type === 'series') {
         if (ch.plot) extraParts.push(`plot="${sanitizeMetadata(ch.plot)}"`);
         if (ch.cast) extraParts.push(`cast="${sanitizeMetadata(ch.cast)}"`);
         if (ch.director) extraParts.push(`director="${sanitizeMetadata(ch.director)}"`);
         if (ch.genre) extraParts.push(`genre="${sanitizeMetadata(ch.genre)}"`);
         if (ch.releaseDate) extraParts.push(`releaseDate="${sanitizeMetadata(ch.releaseDate)}"`);
         if (ch.rating) extraParts.push(`rating="${sanitizeMetadata(ch.rating)}"`);
         if (ch.episode_run_time) extraParts.push(`duration="${sanitizeMetadata(ch.episode_run_time)}"`);
      }
      const extra = extraParts.length > 0 ? ' ' + extraParts.join(' ') : '';
      const groupId = ch.user_category_id || '';

      // Also sanitize the raw name at the end, just in case (though it's outside quotes, newlines are deadly)
      let finalName = String(name);
      if (finalName.indexOf('\n') !== -1 || finalName.indexOf('\r') !== -1) {
          finalName = finalName.replace(/[\r\n]+/g, ' ');
      }
      finalName = finalName.trim();

      buffer += `#EXTINF:-1 tvg-id="${epgId}" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-id="${groupId}" group-title="${safeGroup}"${extra},${finalName}\n`;

      if (ch.drm_license_type || ch.drm_license_key) {
          if (ch.drm_license_type) buffer += `#KODIPROP:inputstream.adaptive.license_type=${ch.drm_license_type}\n`;
          if (ch.drm_license_key) buffer += `#KODIPROP:inputstream.adaptive.license_key=${ch.drm_license_key}\n`;
      }

      buffer += streamUrl + '\n';

      if (buffer.length >= FLUSH_LIMIT) {
          res.write(buffer);
          buffer = '';
      }
        }
    }

    if (buffer.length > 0) {
        res.write(buffer);
    }
    res.end(); // Add final newline equivalent implicitly or via logic above

  } catch (e) {
    console.error('Playlist generation error:', e);
    res.status(500).send('#EXTM3U\n');
  }
};
