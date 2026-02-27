import db from '../database/db.js';
import { getXtreamUser } from '../services/authService.js';
import { getEpgPrograms, getEpgXmlForChannels } from '../services/epgService.js';
import { decrypt } from '../utils/crypto.js';
import { getBaseUrl } from '../utils/helpers.js';
import fetch from 'node-fetch';
import { PORT } from '../config/constants.js';

const sanitizeM3uTag = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\r\n]+/g, ' ').replace(/"/g, '').trim();
};

const sanitizeM3uName = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\r\n]+/g, ' ').replace(/,/g, ' ').replace(/"/g, '').trim();
};

const sanitizeMetadata = (val) => {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim();
};

export const playerApi = async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const action = (req.query.action || '').trim();

    const user = await getXtreamUser(req);
    if (!user) {
      return res.json({user_info: {auth: 0, message: 'Invalid credentials'}});
    }

    if (user.is_share_guest) {
        return res.json({user_info: {auth: 0, message: 'Access denied'}});
    }

    const now = Math.floor(Date.now() / 1000);

    if (!action || action === '') {
      return res.json({
        user_info: {
          username: username,
          password: password,
          message: '',
          auth: 1,
          status: 'Active',
          exp_date: '1773864593',
          is_trial: '0',
          active_cons: '0',
          created_at: now.toString(),
          max_connections: '1',
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
      const cats = db.prepare(`
        SELECT DISTINCT cat.*
        FROM user_categories cat
        JOIN user_channels uc ON uc.user_category_id = cat.id
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        WHERE cat.user_id = ? AND pc.stream_type = ?
        ORDER BY cat.sort_order
      `).all(user.id, type);

      return cats.map(c => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
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
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult,
               map.epg_channel_id as manual_epg_id
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ? AND pc.stream_type = 'live'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        let iconUrl = ch.logo || '';
        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'live',
          stream_id: Number(ch.user_channel_id),
          stream_icon: iconUrl,
          epg_channel_id: ch.manual_epg_id || ch.epg_channel_id || '',
          added: now.toString(),
          is_adult: ch.category_is_adult || 0,
          category_id: String(ch.user_category_id),
          category_ids: [Number(ch.user_category_id)],
          custom_sid: null,
          tv_archive: ch.tv_archive || 0,
          direct_source: '',
          tv_archive_duration: ch.tv_archive_duration || 0
        };
      });
      return res.json(result);
    }

    if (action === 'get_vod_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.name, pc.logo, pc.mime_type, pc.rating, pc.rating_5based, pc.added, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ? AND pc.stream_type = 'movie'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'movie',
          stream_id: Number(ch.user_channel_id),
          stream_icon: ch.logo || '',
          rating: ch.rating || '',
          rating_5based: ch.rating_5based || 0,
          added: ch.added || now.toString(),
          category_id: String(ch.user_category_id),
          container_extension: ch.mime_type || 'mp4',
          custom_sid: null,
          direct_source: ''
        };
      });
      return res.json(result);
    }

    if (action === 'get_series') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.name, pc.logo, pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.added, pc.rating, pc.rating_5based, pc.youtube_trailer, pc.episode_run_time, pc.metadata, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ? AND pc.stream_type = 'series'
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = rows.map((ch, i) => {
        let backdrop_path = [];
        if (ch.metadata) {
             try {
                 const meta = JSON.parse(ch.metadata);
                 if (meta.backdrop_path) backdrop_path = meta.backdrop_path;
             } catch(e){}
        }

        return {
          num: i + 1,
          name: ch.name,
          series_id: Number(ch.user_channel_id),
          cover: ch.logo || '',
          plot: ch.plot || '',
          cast: ch.cast || '',
          director: ch.director || '',
          genre: ch.genre || '',
          releaseDate: ch.releaseDate || '',
          last_modified: ch.added || now.toString(),
          rating: ch.rating || '',
          rating_5based: ch.rating_5based || 0,
          backdrop_path: backdrop_path,
          youtube_trailer: ch.youtube_trailer || '',
          episode_run_time: ch.episode_run_time || '',
          category_id: String(ch.user_category_id)
        };
      });
      return res.json(result);
    }

    if (action === 'get_series_info') {
      const seriesId = Number(req.query.series_id);
      if (!seriesId) return res.json({});

      const channel = db.prepare(`
        SELECT uc.id as user_channel_id, pc.*, p.url, p.username, p.password
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ?
      `).get(seriesId, user.id);

      if (!channel) return res.json({});

      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteSeriesId = channel.remote_stream_id;

      try {
        const resp = await fetch(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_series_info&series_id=${remoteSeriesId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        const OFFSET = 1000000000;
        const providerId = channel.provider_id;

        if (data.episodes) {
           for (const seasonKey in data.episodes) {
              const episodes = data.episodes[seasonKey];
              if (Array.isArray(episodes)) {
                 episodes.forEach(ep => {
                    const originalId = Number(ep.id);
                    ep.id = (providerId * OFFSET + originalId).toString();
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
        SELECT uc.id as user_channel_id, pc.*, p.url, p.username, p.password
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE uc.id = ? AND cat.user_id = ?
      `).get(vodId, user.id);

      if (!channel) return res.json({});

      const provPass = decrypt(channel.password);
      const baseUrl = channel.url.replace(/\/+$/, '');
      const remoteVodId = channel.remote_stream_id;

      try {
        const resp = await fetch(`${baseUrl}/player_api.php?username=${encodeURIComponent(channel.username)}&password=${encodeURIComponent(provPass)}&action=get_vod_info&vod_id=${remoteVodId}`);
        if (!resp.ok) return res.json({});

        const data = await resp.json();

        // Ensure stream_id matches our user_channel_id
        if (data && data.movie_data && data.movie_data.stream_id) {
           data.movie_data.stream_id = Number(channel.user_channel_id);
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
        WHERE uc.id = ? AND cat.user_id = ?
      `).get(streamId, user.id);

      if (!channel) return res.json({epg_listings: []});

      const epgId = channel.manual_epg_id || channel.epg_channel_id;
      if (!epgId) return res.json({epg_listings: []});

      const programs = await getEpgPrograms(epgId, limit);

      const listings = programs.map(p => {
          // Format dates as YYYY-MM-DD HH:MM:SS
          // p.start and p.stop are unix timestamps (seconds)
          const format = (ts) => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');

          return {
              id: String(p.start), // Unique ID for program? usually random or timestamp
              epg_id: epgId,
              title: p.title ? Buffer.from(p.title).toString('base64') : '',
              lang: p.lang || '',
              start: format(p.start),
              end: format(p.stop),
              description: p.desc ? Buffer.from(p.desc).toString('base64') : '',
              channel_id: epgId,
              start_timestamp: String(p.start),
              stop_timestamp: String(p.stop)
          };
      });

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

    const rows = db.prepare(`
      SELECT uc.id as user_channel_id, pc.name, pc.logo, pc.epg_channel_id, pc.stream_type, pc.mime_type,
             cat.name as category_name, map.epg_channel_id as manual_epg_id
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ?
      ORDER BY uc.sort_order
    `).all(user.id);

    const baseUrl = getBaseUrl(req);
    // Use an array to build the playlist, optimizing performance for large lists
    let header = '#EXTM3U';

    if (type === 'm3u_plus') {
       header += ` url-tvg="${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}"`;
    }

    const lines = [header];

    for (const ch of rows) {
      const epgId = ch.manual_epg_id || ch.epg_channel_id || '';
      const logo = ch.logo || '';
      const group = ch.category_name || '';
      const name = ch.name || 'Unknown';
      const streamId = ch.user_channel_id;

      let ext = output === 'hls' ? 'm3u8' : 'ts';
      let typePath = 'live';

      if (ch.stream_type === 'movie') {
         typePath = 'movie';
         ext = ch.mime_type || 'mp4';
      } else if (ch.stream_type === 'series') {
         typePath = 'series';
         ext = ch.mime_type || 'mp4';
      }

      const streamUrl = `${baseUrl}/${typePath}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;

      const safeName = sanitizeM3uName(name);
      const safeLogo = sanitizeM3uTag(logo);
      const safeGroup = sanitizeM3uTag(group);
      const finalName = String(name).replace(/[\r\n]+/g, ' ').trim();

      if (type === 'm3u_plus') {
        lines.push(`#EXTINF:-1 tvg-id="${epgId}" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-title="${safeGroup}",${finalName}`);
      } else {
        lines.push(`#EXTINF:-1,${finalName}`);
      }
      lines.push(streamUrl);
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Content-Disposition', `attachment; filename="playlist.m3u"`);
    res.send(lines.join('\n') + '\n');

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
    const rows = db.prepare(`
        SELECT DISTINCT COALESCE(map.epg_channel_id, pc.epg_channel_id) as epg_id
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
        WHERE cat.user_id = ?
        AND (map.epg_channel_id IS NOT NULL OR pc.epg_channel_id IS NOT NULL)
    `).all(user.id);

    const allowedIds = new Set(rows.map(r => r.epg_id).filter(id => id));

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

export const playerPlaylist = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.status(401).send('Unauthorized');

    let channels = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.name,
        pc.logo,
        pc.epg_channel_id,
        pc.remote_stream_id,
        pc.stream_type,
        pc.mime_type,
        pc.metadata,
        pc.plot, pc."cast", pc.director, pc.genre, pc.releaseDate, pc.rating, pc.episode_run_time,
        cat.name as category_name,
        map.epg_channel_id as manual_epg_id
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE cat.user_id = ? AND pc.stream_type != 'series'
      ORDER BY uc.sort_order
    `).all(user.id);

    if (user.is_share_guest) {
        channels = channels.filter(ch => user.allowed_channels.includes(ch.user_channel_id));

        // Also check start/end time validity for the playlist itself (though stream controller enforces it too)
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) {
             channels = [];
        }
    }

    // Use an array to build the playlist, optimizing performance for large lists
    const lines = ['#EXTM3U'];
    const host = getBaseUrl(req);
    const tokenParam = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';

    for (const ch of channels) {
      const group = ch.category_name || 'Uncategorized';
      const logo = ch.logo || '';
      const name = ch.name || 'Unknown';

      let ext = 'ts';
      let typePath = 'live';

      if (ch.stream_type === 'movie') {
         typePath = 'movie';
         ext = ch.mime_type || 'mp4';
      } else if (ch.stream_type === 'series') {
         typePath = 'series';
         ext = ch.mime_type || 'mp4';
      } else {
         if (ch.mime_type === 'mpd') {
             ext = 'mpd';
             typePath = 'live/mpd';
         } else {
             ext = 'ts';
         }
      }

      let streamUrl;
      if (ext === 'mpd') {
          streamUrl = `${host}/${typePath}/token/auth/${ch.user_channel_id}/manifest.mpd${tokenParam}`;
      } else {
          streamUrl = `${host}/${typePath}/token/auth/${ch.user_channel_id}.${ext}${tokenParam}`;
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

      // Also sanitize the raw name at the end, just in case (though it's outside quotes, newlines are deadly)
      const finalName = String(name).replace(/[\r\n]+/g, ' ').trim();

      lines.push(`#EXTINF:-1 tvg-id="${epgId}" tvg-name="${safeName}" tvg-logo="${safeLogo}" group-title="${safeGroup}"${extra},${finalName}`);

      if (ch.metadata) {
          try {
              const meta = typeof ch.metadata === 'string' ? JSON.parse(ch.metadata) : ch.metadata;
              if (meta.drm) {
                  if (meta.drm.license_type) lines.push(`#KODIPROP:inputstream.adaptive.license_type=${meta.drm.license_type}`);
                  if (meta.drm.license_key) lines.push(`#KODIPROP:inputstream.adaptive.license_key=${meta.drm.license_key}`);
              }
          } catch(e) {}
      }

      lines.push(streamUrl);
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.send(lines.join('\n') + '\n'); // Add final newline

  } catch (e) {
    console.error('Playlist generation error:', e);
    res.status(500).send('#EXTM3U\n');
  }
};
