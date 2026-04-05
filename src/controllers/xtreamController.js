import db from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';
import { getEpgPrograms, getEpgXmlForChannels } from '../services/epgService.js';
import { channelsJsonCache } from '../services/cacheService.js';
import { decrypt } from '../utils/crypto.js';
import { getBaseUrl } from '../utils/helpers.js';
import { fetchSafe } from '../utils/network.js';
import { PORT } from '../config/constants.js';
import { episodeNameCache } from '../services/episodeCache.js';
import { getEpgLogo, loadEpgLogosCache } from '../services/logoResolver.js';

const sanitizeM3uTag = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, '');
  return str.trim();
};

const sanitizeM3uName = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf(',') !== -1) str = str.replace(/,/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, '');
  return str.trim();
};

const sanitizeMetadata = (val) => {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // ⚡ Bolt: Fast-path check to avoid expensive regex allocations for strings without newlines
  if (str.indexOf('\n') !== -1 || str.indexOf('\r') !== -1) str = str.replace(/[\r\n]+/g, ' ');
  if (str.indexOf('"') !== -1) str = str.replace(/"/g, "'");
  return str.trim();
};

export const cppEndpoint = (req, res) => {
  res.json(true);
};

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

    if (user.is_share_guest) {
        return res.json({user_info: {auth: 0, message: 'Access denied'}});
    }

    const now = Math.floor(Date.now() / 1000);

    if (!action || action === '') {
      const { default: streamManager } = await import('../services/streamManager.js');
      const activeCons = await streamManager.getUserConnectionCount(user.id);

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
          allowed_output_formats: ['m3u8', 'ts']
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
      const stmt = db.prepare(`
        SELECT DISTINCT cat.*
        FROM user_categories cat
        JOIN user_channels uc ON uc.user_category_id = cat.id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = ? AND uc.is_hidden = 0
        ORDER BY cat.sort_order
      `);

      const categories = [];
      for (const c of stmt.iterate(user.id, type)) {
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
        JOIN user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND pc.stream_type = 'live' AND uc.is_hidden = 0`;
      const params = [user.id];

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
      const result = [];
      let i = 0;
      for (const ch of stmt.iterate(...params)) {
        let iconUrl = ch.logo || '';
        const displayName = ch.custom_name ? ch.custom_name : ch.name;
        result.push({
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
        });
        i++;
      }
      return res.json(result);
    }

    if (action === 'get_vod_streams') {
      const categoryId = req.query.category_id ? String(req.query.category_id).trim() : null;
      let query = `
        SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_categories cat
        JOIN user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = 'movie' AND uc.is_hidden = 0`;
      const params = [user.id];

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
      const result = [];
      let i = 0;
      for (const ch of stmt.iterate(...params)) {
        const displayName = ch.custom_name ? ch.custom_name : ch.name;
        result.push({
          num: i + 1,
          name: displayName,
          stream_type: 'movie',
          stream_id: Number(ch.user_channel_id),
          stream_icon: ch.logo || '',
          rating: ch.rating || '',
          rating_5based: ch.rating_5based || 0,
          added: ch.added || nowStr,
          category_id: String(ch.user_category_id),
          container_extension: ch.mime_type || 'mp4',
          custom_sid: null,
          direct_source: ''
        });
        i++;
      }
      return res.json(result);
    }

    if (action === 'get_series') {
      const categoryId = req.query.category_id ? String(req.query.category_id).trim() : null;
      let query = `
        SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.name, pc.logo, pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.added, pc.rating, pc.rating_5based, pc.youtube_trailer, pc.episode_run_time,
               json_extract(pc.metadata, '$.backdrop_path') as backdrop_path,
               cat.is_adult as category_is_adult
        FROM user_categories cat
        JOIN user_channels uc ON cat.id = uc.user_category_id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = 'series' AND uc.is_hidden = 0`;
      const params = [user.id];

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
      const result = [];
      let i = 0;
      for (const ch of stmt.iterate(...params)) {
        let backdrop_path = [];
        if (ch.backdrop_path) {
             try {
                 const parsed = JSON.parse(ch.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch(e){}
        }

        const displayName = ch.custom_name ? ch.custom_name : ch.name;

        result.push({
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
        });
        i++;
      }
      return res.json(result);
    }

    if (action === 'get_series_info') {
      const seriesId = Number(req.query.series_id);
      if (!seriesId) return res.json({});

      const channel = db.prepare(`
        SELECT uc.id as user_channel_id, uc.custom_name, pc.*, p.url, p.username, p.password
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(seriesId, user.id);

      if (!channel) return res.json({});

      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteSeriesId = channel.remote_stream_id;

      try {
        const resp = await fetchSafe(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_series_info&series_id=${remoteSeriesId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        const OFFSET = 1000000000;
        const providerId = channel.provider_id;

        if (data.info && channel.custom_name) {
            data.info.name = channel.custom_name;
        }

        if (data.episodes) {
           for (const seasonKey in data.episodes) {
              const episodes = data.episodes[seasonKey];
              if (Array.isArray(episodes)) {
                 episodes.forEach(ep => {
                    const originalId = Number(ep.id);
                    const newId = (providerId * OFFSET + originalId).toString();
                    ep.id = newId;

                    // Cache the episode name for the active streams dashboard
                    const seriesName = data.info ? data.info.name : 'Unknown Series';
                    const epTitle = ep.title ? ep.title : `Episode ${originalId}`;
                    episodeNameCache.set(newId, `${seriesName} - ${epTitle}`);
                 });
              }
           }
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
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(vodId, user.id);

      if (!channel) return res.json({});

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
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE uc.id = ? AND cat.user_id = ? AND uc.is_hidden = 0
      `).get(streamId, user.id);

      if (!channel) return res.json({epg_listings: []});

      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      if (!epgId) return res.json({epg_listings: []});

      // ⚡ Bolt: Remove await since getEpgPrograms now returns a synchronous iterator
      const programs = getEpgPrograms(epgId, limit);

      const listings = [];
      // ⚡ Bolt: Iterate directly over the SQLite generator and use pre-formatted dates
      for (const p of programs) {
          listings.push({
              id: String(p.start), // Unique ID for program? usually random or timestamp
              epg_id: epgId,
              title: p.title ? Buffer.from(p.title).toString('base64') : '',
              lang: p.lang || '',
              start: p.start_fmt,
              end: p.stop_fmt,
              description: p.desc ? Buffer.from(p.desc).toString('base64') : '',
              channel_id: epgId,
              start_timestamp: String(p.start),
              stop_timestamp: String(p.stop)
          });
      }

      return res.json({epg_listings: listings});
    }

    res.status(400).json([]);
  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
  }
};

export const getPlaylist = async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const type = (req.query.type || 'm3u').trim();
    const output = (req.query.output || 'ts').trim();

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    if (user.is_share_guest) return res.sendStatus(403);

    const stmt = db.prepare(`
      SELECT uc.id as user_channel_id, uc.custom_name, uc.user_category_id, pc.name, pc.logo, pc.epg_channel_id, pc.stream_type, pc.mime_type,
        pc.tv_archive,
        pc.tv_archive_duration,
             cat.name as category_name, map.epg_channel_id as manual_epg_id
      FROM user_categories cat
      JOIN user_channels uc ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ? AND uc.is_hidden = 0
      -- ⚡ Bolt: Optimize ORDER BY clause using composite index to remove temporary B-tree allocation
      ORDER BY cat.sort_order ASC, uc.sort_order ASC
    `);

    const baseUrl = getBaseUrl(req);
    let header = '#EXTM3U';

    if (type === 'm3u_plus') {
       header += ` url-tvg="${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}"`;
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
    const encUser = encodeURIComponent(username);
    const encPass = encodeURIComponent(password);
    const livePrefix = `${baseUrl}/live/${encUser}/${encPass}/`;
    const moviePrefix = `${baseUrl}/movie/${encUser}/${encPass}/`;
    const seriesPrefix = `${baseUrl}/series/${encUser}/${encPass}/`;

    // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
    // 🎯 Why: Loading 50,000+ channel objects into V8 memory at once can cause memory spikes and block the event loop.
    // 📊 Impact: Drastically reduces peak memory usage and improves response time for massive playlists.
    for (const ch of stmt.iterate(user.id)) {
      const epgId = ch.manual_epg_id || ch.epg_channel_id || '';
      const logo = ch.logo || '';
      const group = ch.category_name || '';
      const name = ch.custom_name ? ch.custom_name : (ch.name || 'Unknown');
      const streamId = ch.user_channel_id;

      let streamUrl;
      if (ch.stream_type === 'movie') {
         streamUrl = moviePrefix + streamId + '.' + (ch.mime_type || 'mp4');
      } else if (ch.stream_type === 'series') {
         streamUrl = seriesPrefix + streamId + '.' + (ch.mime_type || 'mp4');
      } else {
         streamUrl = livePrefix + streamId + '.' + (output === 'hls' ? 'm3u8' : 'ts');
      }

      const safeName = sanitizeM3uName(name);
      const safeLogo = sanitizeM3uTag(logo);
      const safeGroup = sanitizeM3uTag(group);
      const groupId = ch.user_category_id || '';

      let finalName = String(name);
      if (finalName.indexOf('\n') !== -1 || finalName.indexOf('\r') !== -1) {
          finalName = finalName.replace(/[\r\n]+/g, ' ');
      }
      finalName = finalName.trim();

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

    if (user.is_share_guest) return res.sendStatus(403);

    // Get allowed EPG IDs for this user
    const allowedIds = new Set();
    const stmt = db.prepare(`
        SELECT DISTINCT COALESCE(map.epg_channel_id, pc.epg_channel_id) as epg_id
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND uc.is_hidden = 0
        AND (map.epg_channel_id IS NOT NULL OR pc.epg_channel_id IS NOT NULL)
    `);

    // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
    // 🎯 Why: Using .all().map() creates massive intermediate arrays in V8 memory.
    // 📊 Impact: Significantly reduces peak garbage collection pressure and memory usage for large EPGs.
    for (const r of stmt.iterate(user.id)) {
        if (r.epg_id) allowedIds.add(r.epg_id);
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

    // Use the generator to stream content
    for await (const chunk of getEpgXmlForChannels(allowedIds)) {
        res.write(chunk);
    }

    res.write('</tv>');
    res.end();

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
        pc.stream_type,
        pc.tv_archive,
        pc.tv_archive_duration,
        pc.mime_type,
        json_extract(pc.metadata, '$.drm.license_type') as drm_license_type,
        json_extract(pc.metadata, '$.drm.license_key') as drm_license_key,
        pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.rating, pc.episode_run_time,
        cat.name as category_name,
        map.epg_channel_id as manual_epg_id,
        p.use_mapped_epg_icon
      FROM user_categories cat
      JOIN user_channels uc ON cat.id = uc.user_category_id
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

    const result = [];

    if (!isExpired) {
        // ⚡ Bolt: Pre-construct URL prefixes outside of the tight loop.
        // 🎯 Why: Generating the prefix repeatedly for 50,000+ items consumes unnecessary CPU cycles.
        // 📊 Impact: Optimizes the JSON payload generation loop.
        const livePrefix = `${host}/live/token/auth/`;
        const liveMpdPrefix = `${host}/live/mpd/token/auth/`;
        const moviePrefix = `${host}/movie/token/auth/`;
        const seriesPrefix = `${host}/series/token/auth/`;

        // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
        // 🎯 Why: Loading massive lists of channel objects into V8 memory at once can cause memory spikes.
        // 📊 Impact: Reduces peak memory usage and iterates rows as they are returned.
        for (const ch of stmt.iterate(user.id)) {
          if (allowedSet && !allowedSet.has(ch.user_channel_id)) continue;

          const group = ch.category_name || 'Uncategorized';
          // Resolve logo: prefer EPG logo if provider has use_mapped_epg_icon enabled
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

          let streamUrl;
          let type = 'live';

          if (ch.stream_type === 'movie') {
             type = 'movie';
             streamUrl = moviePrefix + ch.user_channel_id + '.' + (ch.mime_type || 'mp4') + tokenParam;
          } else if (ch.stream_type === 'series') {
             type = 'series';
             streamUrl = seriesPrefix + ch.user_channel_id + '.' + (ch.mime_type || 'mp4') + tokenParam;
      } else {
         if (ch.mime_type === 'mpd') {
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
        tv_archive: ch.tv_archive || 0,
        tv_archive_duration: ch.tv_archive_duration || 0
      };

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

          result.push(item);
        }
    }

    const jsonOutput = JSON.stringify(result);
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
      JOIN user_channels uc ON cat.id = uc.user_category_id
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
        const seriesPrefix = `${host}/series/token/auth/`;

        // ⚡ Bolt: Replace .all() with .iterate() to stream rows directly from SQLite.
        // 🎯 Why: Loading 50,000+ channel objects into V8 memory at once can cause memory spikes and block the event loop.
        // 📊 Impact: Drastically reduces peak memory usage and improves response time for massive playlists.
        for (const ch of stmt.iterate(user.id)) {
          if (allowedSet && !allowedSet.has(ch.user_channel_id)) continue;

          const group = ch.category_name || 'Uncategorized';
      const logo = ch.logo || '';
      const name = ch.name || 'Unknown';

      let streamUrl;
      if (ch.stream_type === 'movie') {
         streamUrl = moviePrefix + ch.user_channel_id + '.' + (ch.mime_type || 'mp4') + tokenParam;
      } else if (ch.stream_type === 'series') {
         streamUrl = seriesPrefix + ch.user_channel_id + '.' + (ch.mime_type || 'mp4') + tokenParam;
      } else {
         if (ch.mime_type === 'mpd') {
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
