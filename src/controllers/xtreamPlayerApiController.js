import db from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';
import { getEpgPrograms, getEpgProgramsForChannels } from '../services/epgService.js';
import { decrypt } from '../utils/crypto.js';
import { providerSourceKey } from '../utils/helpers.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { fetchSafe } from '../utils/network.js';
import { PORT } from '../config/constants.js';
import { episodeNameCache } from '../services/episodeCache.js';
import {
  getOrCreateSeriesEpisodeAlias,
  prepareSeriesEpisodeAliases
} from '../utils/seriesEpisodeId.js';
import {
  appendAllowedChannelFilter,
  formatXtreamEpgListing,
  getBatchDateRange,
  getShareScope,
  getShareValidityInfo,
  parseBatchStreamIds,
  streamJsonResponse
} from './xtreamControllerUtils.js';

export const playerApi = async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const action = (req.query.action || '').trim();

    if (action === 'cpp') {
      return res.json(true);
    }

    const user = await getXtreamUser(req);
    if (!user) {
      return res.json({user_info: {auth: 0, message: 'Invalid credentials'}});
    }

    const now = Math.floor(Date.now() / 1000);
    const shareScope = getShareScope(user);
    if (shareScope.isExpired) {
      return res.json({
        user_info: {
          auth: 0,
          message: 'Share expired',
          ...getShareValidityInfo(user, now)
        }
      });
    }

    if (!action || action === '') {
      const { default: streamManager } = await import('../services/streamManager.js');
      const activeCons = await streamManager.getUserConnectionCount(user.id);
      const shareValidity = getShareValidityInfo(user, now);

      return res.json({
        user_info: {
          username: username,
          password: password,
          message: '',
          auth: 1,
          status: 'Active',
          exp_date: user.expiry_date ? Math.floor(new Date(user.expiry_date).getTime() / 1000).toString() : '1773864593',
          is_trial: '0',
          active_cons: activeCons,
          created_at: now.toString(),
          max_connections: user.max_connections === 0 ? 999999 : (user.max_connections || 1),
          allowed_output_formats: ['m3u8', 'ts'],
          ...shareValidity
        },
        server_info: {
          url: req.hostname,
          port: String(PORT),
          https_port: '',
          server_protocol: req.secure ? 'https' : 'http',
          rtmp_port: '',
          timezone: 'Europe/Berlin',
          timestamp_now: now,
          time_now: new Date(now * 1000).toISOString().slice(0, 19).replace('T', ' '),
          process: true
        }
      });
    }

    const getUserCategoriesByType = (type) => {
      // ⚡ Bolt: Replace .all().map() with .iterate() to eliminate intermediate V8 array allocation overhead
      // 🎯 Why: Using .all().map() creates intermediate arrays. iterate() streams rows directly from SQLite.
      // 📊 Impact: Lowers peak memory usage and garbage collection pressure when processing large category lists.
      let query = `
        SELECT DISTINCT cat.*
        FROM user_categories cat
        JOIN authorized_user_channels uc ON uc.user_category_id = cat.id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = ? AND uc.is_hidden = 0
      `;
      let params = [user.id, type];
      ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));
      query += ' ORDER BY cat.sort_order';
      const stmt = db.prepare(query);

      const categories = [];
      for (const c of stmt.iterate(...params)) {
        categories.push({
          category_id: String(c.id),
          category_name: c.name,
          parent_id: 0,
          is_adult: c.is_adult || 0
        });
      }
      return categories;
    };

    if (action === 'get_live_categories') {
      return res.json(getUserCategoriesByType('live'));
    }

    if (action === 'get_vod_categories') {
      return res.json(getUserCategoriesByType('movie'));
    }

    if (action === 'get_series_categories') {
      return res.json(getUserCategoriesByType('series'));
    }

    if (action === 'get_live_streams') {
      const categoryId = req.query.category_id ? String(req.query.category_id).trim() : null;
      let query = `
        SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.*, cat.is_adult as category_is_adult,
               map.epg_channel_id as manual_epg_id
        FROM user_categories cat
        JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND pc.stream_type = 'live' AND uc.is_hidden = 0`;
      let params = [user.id];
      ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));

      if (categoryId && categoryId !== '*' && categoryId !== '0') {
          query += ' AND cat.id = ?';
          params.push(Number(categoryId));
      }
      // ⚡ Bolt: Include cat.sort_order in the ORDER BY clause to fully utilize the composite index idx_cat_user_sort
      // This eliminates an expensive temporary B-tree sorting pass for tens of thousands of channels
      query += ' ORDER BY cat.sort_order ASC, uc.sort_order ASC';

      // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
      // 🎯 Why: Loading massive lists of channel objects into V8 memory at once can cause memory spikes.
      // 📊 Impact: Reduces peak memory usage and iterates rows as they are returned.
      const stmt = db.prepare(query);

      const nowStr = now.toString();
      return streamJsonResponse(res, stmt, params, (ch, i) => {
        let iconUrl = ch.logo || '';
        const displayName = ch.custom_name ? ch.custom_name : ch.name;
        return {
          num: i + 1,
          name: displayName,
          stream_type: 'live',
          stream_id: Number(ch.user_channel_id),
          stream_icon: iconUrl,
          epg_channel_id: ch.manual_epg_id || ch.epg_channel_id || '',
          added: nowStr,
          is_adult: ch.category_is_adult || 0,
          category_id: String(ch.user_category_id),
          category_ids: [Number(ch.user_category_id)],
          custom_sid: null,
          tv_archive: ch.tv_archive || 0,
          direct_source: '',
          tv_archive_duration: ch.tv_archive_duration || 0
        };
      });
    }

    if (action === 'get_vod_streams') {
      const categoryId = req.query.category_id ? String(req.query.category_id).trim() : null;
      let query = `
        SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_categories cat
        JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = 'movie' AND uc.is_hidden = 0`;
      let params = [user.id];
      ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));

      if (categoryId && categoryId !== '*' && categoryId !== '0') {
          query += ' AND cat.id = ?';
          params.push(Number(categoryId));
      }
      // ⚡ Bolt: Include cat.sort_order in the ORDER BY clause to fully utilize the composite index idx_cat_user_sort
      // This eliminates an expensive temporary B-tree sorting pass for tens of thousands of channels
      query += ' ORDER BY cat.sort_order ASC, uc.sort_order ASC';

      // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
      // 🎯 Why: Loading massive lists of channel objects into V8 memory at once can cause memory spikes.
      // 📊 Impact: Reduces peak memory usage and iterates rows as they are returned.
      const stmt = db.prepare(query);

      const nowStr = now.toString();
      return streamJsonResponse(res, stmt, params, (ch, i) => {
        const displayName = ch.custom_name ? ch.custom_name : ch.name;
        return {
          num: i + 1,
          name: displayName,
          stream_type: 'movie',
          stream_id: Number(ch.user_channel_id),
          stream_icon: ch.logo || '',
          rating: ch.rating || '',
          rating_5based: ch.rating_5based || 0,
          added: ch.added || nowStr,
          category_id: String(ch.user_category_id),
          container_extension: normalizeContainerExtension(ch.mime_type),
          custom_sid: null,
          direct_source: ''
        };
      });
    }

    if (action === 'get_series') {
      const categoryId = req.query.category_id ? String(req.query.category_id).trim() : null;
      let query = `
        SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.name, pc.logo, pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.added, pc.rating, pc.rating_5based, pc.youtube_trailer, pc.episode_run_time,
               json_extract(pc.metadata, '$.backdrop_path') as backdrop_path,
               cat.is_adult as category_is_adult
        FROM user_categories cat
        JOIN authorized_user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = 'series' AND uc.is_hidden = 0`;
      let params = [user.id];
      ({ query, params } = appendAllowedChannelFilter(query, params, shareScope.allowedChannelIds));

      if (categoryId && categoryId !== '*' && categoryId !== '0') {
          query += ' AND cat.id = ?';
          params.push(Number(categoryId));
      }
      // ⚡ Bolt: Include cat.sort_order in the ORDER BY clause to fully utilize the composite index idx_cat_user_sort
      // This eliminates an expensive temporary B-tree sorting pass for tens of thousands of channels
      query += ' ORDER BY cat.sort_order ASC, uc.sort_order ASC';

      // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
      // 🎯 Why: Loading massive lists of channel objects into V8 memory at once can cause memory spikes.
      // 📊 Impact: Reduces peak memory usage and iterates rows as they are returned.
      const stmt = db.prepare(query);

      const nowStr = now.toString();
      return streamJsonResponse(res, stmt, params, (ch, i) => {
        let backdrop_path = [];
        if (ch.backdrop_path) {
             try {
                 const parsed = JSON.parse(ch.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch{}
        }

        const displayName = ch.custom_name ? ch.custom_name : ch.name;

        return {
          num: i + 1,
          name: displayName,
          series_id: Number(ch.user_channel_id),
          cover: ch.logo || '',
          plot: ch.plot || '',
          cast: ch.cast || '',
          director: ch.director || '',
          genre: ch.genre || '',
          releaseDate: ch.releaseDate || '',
          last_modified: ch.added || nowStr,
          rating: ch.rating || '',
          rating_5based: ch.rating_5based || 0,
          backdrop_path: backdrop_path,
          youtube_trailer: ch.youtube_trailer || '',
          episode_run_time: ch.episode_run_time || '',
          category_id: String(ch.user_category_id)
        };
      });
    }

    if (action === 'get_series_info') {
      const seriesId = Number(req.query.series_id);
      if (!seriesId) return res.json({});

      const channel = db.prepare(`
        SELECT uc.id as user_channel_id, uc.custom_name, pc.*, p.url, p.username, p.password
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0 AND pc.stream_type = 'series'
      `).get(seriesId, user.id);

      if (!channel) return res.json({});
      if (shareScope.allowedSet && !shareScope.allowedSet.has(Number(channel.user_channel_id))) return res.json({});

      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteSeriesId = channel.remote_stream_id;

      try {
        const resp = await fetchSafe(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_series_info&series_id=${remoteSeriesId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        if (data.info && channel.custom_name) {
            data.info.name = channel.custom_name;
        }

        if (data.episodes) {
           const sourceKey = providerSourceKey(channel.url);
           const episodeAliases = prepareSeriesEpisodeAliases(db);
           const upsertEpisode = db.prepare(`
             INSERT INTO provider_series_episodes
               (source_key, series_remote_id, remote_episode_id, season, episode_num, title, container_extension, logo, added)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_key, series_remote_id, remote_episode_id) DO UPDATE SET
               season = excluded.season,
               episode_num = excluded.episode_num,
               title = excluded.title,
               container_extension = excluded.container_extension,
               logo = excluded.logo,
               added = excluded.added
           `);
           db.transaction(() => {
             for (const seasonKey in data.episodes) {
                const episodes = data.episodes[seasonKey];
                if (!Array.isArray(episodes)) continue;
                data.episodes[seasonKey] = episodes.filter(ep => {
                    const originalId = Number(ep.id);
                    const newId = getOrCreateSeriesEpisodeAlias(
                      episodeAliases,
                      channel.user_channel_id,
                      sourceKey,
                      remoteSeriesId,
                      originalId
                    );
                    if (!newId) return false;
                    upsertEpisode.run(
                      sourceKey,
                      remoteSeriesId,
                      originalId,
                      Number(ep.season ?? seasonKey) || 0,
                      Number(ep.episode_num) || 0,
                      ep.title || '',
                      normalizeContainerExtension(ep.container_extension),
                      ep.info?.movie_image || ep.movie_image || ep.cover || '',
                      ep.added || ''
                    );
                    ep.id = newId;
                    ep.container_extension = normalizeContainerExtension(ep.container_extension);

                    // Cache the episode name for the active streams dashboard
                    const seriesName = data.info ? data.info.name : 'Unknown Series';
                    const epTitle = ep.title ? ep.title : `Episode ${originalId}`;
                    episodeNameCache.set(newId, `${seriesName} - ${epTitle}`);
                    return true;
                });
             }
           })();
        }

        return res.json(data);

      } catch(e) {
         console.error('get_series_info error:', e);
         return res.json({});
      }
    }

    if (action === 'get_vod_info') {
      const vodId = Number(req.query.vod_id);
      if (!vodId) return res.json({});

      const channel = db.prepare(`
        SELECT uc.id as user_channel_id, uc.custom_name, pc.*, p.url, p.username, p.password
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(vodId, user.id);

      if (!channel) return res.json({});
      if (shareScope.allowedSet && !shareScope.allowedSet.has(Number(channel.user_channel_id))) return res.json({});

      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteVodId = channel.remote_stream_id;

      try {
        const resp = await fetchSafe(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_vod_info&vod_id=${remoteVodId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        // Ensure stream_id matches our user_channel_id
        if (data && data.movie_data && data.movie_data.stream_id) {
           data.movie_data.stream_id = Number(channel.user_channel_id);
           if (channel.custom_name) {
               data.movie_data.name = channel.custom_name;
           }
        }

        if (data && data.info && channel.custom_name) {
            data.info.name = channel.custom_name;
        }

        return res.json(data);

      } catch(e) {
         console.error('get_vod_info error:', e);
         return res.json({});
      }
    }

    if (action === 'get_short_epg') {
      const streamId = Number(req.query.stream_id);
      const limit = Number(req.query.limit) || 1;

      if (!streamId) return res.json({epg_listings: []});

      const channel = db.prepare(`
        SELECT pc.epg_channel_id, map.epg_channel_id as manual_epg_id
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(streamId, user.id);

      if (!channel) return res.json({epg_listings: []});
      if (shareScope.allowedSet && !shareScope.allowedSet.has(Number(streamId))) {
        return res.json({epg_listings: []});
      }

      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      if (!epgId) return res.json({epg_listings: []});

      // ⚡ Bolt: Remove await since getEpgPrograms now returns a synchronous iterator
      const programs = getEpgPrograms(epgId, limit);

      const listings = [];
      // ⚡ Bolt: Iterate directly over the SQLite generator and use pre-formatted dates
      for (const p of programs) {
          listings.push(formatXtreamEpgListing(p, epgId));
      }

      return res.json({epg_listings: listings});
    }

    if (action === 'get_simple_date_table' || action === 'get_simple_data_table') {
      const streamId = Number(req.query.stream_id);
      const limit = Math.min(Math.max(Number(req.query.limit) || 5000, 1), 10000);

      if (!streamId) return res.json({epg_listings: []});

      const channel = db.prepare(`
        SELECT pc.epg_channel_id, map.epg_channel_id as manual_epg_id
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(streamId, user.id);

      if (!channel) return res.json({epg_listings: []});
      if (shareScope.allowedSet && !shareScope.allowedSet.has(Number(streamId))) {
        return res.json({epg_listings: []});
      }

      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      if (!epgId) return res.json({epg_listings: []});

      const programs = getEpgPrograms(epgId, limit, { includePast: true });
      const listings = [];
      for (const p of programs) {
        listings.push(formatXtreamEpgListing(p, epgId));
      }

      return res.json({epg_listings: listings});
    }

    if (action === 'get_epg_batch') {
      let streamIds = parseBatchStreamIds(req.query.stream_ids || req.query.stream_id || req.query.ids);
      if (shareScope.allowedSet) {
        streamIds = streamIds.filter((id) => shareScope.allowedSet.has(id));
      }
      if (streamIds.length === 0) return res.json({});

      const placeholders = streamIds.map(() => '?').join(',');
      const channels = db.prepare(`
        SELECT uc.id as user_channel_id, pc.epg_channel_id, map.epg_channel_id as manual_epg_id
        FROM authorized_user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE uc.id IN (${placeholders}) AND cat.user_id = ? AND uc.is_hidden = 0
      `).all(...streamIds, user.id);

      const epgIds = new Set();
      const channelsByStreamId = new Map();
      for (const channel of channels) {
        const epgId = channel.manual_epg_id || channel.epg_channel_id;
        if (!epgId) continue;
        channelsByStreamId.set(Number(channel.user_channel_id), epgId);
        epgIds.add(epgId);
      }

      const response = {};
      for (const streamId of streamIds) {
        if (channelsByStreamId.has(streamId)) {
          response[String(streamId)] = { epg_listings: [] };
        }
      }
      if (epgIds.size === 0) return res.json(response);

      const { start, end } = getBatchDateRange(req.query.date);
      const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
      const programsByEpgId = getEpgProgramsForChannels(epgIds, start, end, limit);

      for (const [streamId, epgId] of channelsByStreamId.entries()) {
        const programs = programsByEpgId.get(epgId) || [];
        response[String(streamId)] = {
          epg_listings: programs.map((program) => formatXtreamEpgListing(program, epgId))
        };
      }

      return res.json(response);
    }

    res.status(400).json([]);
  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
  }
};
