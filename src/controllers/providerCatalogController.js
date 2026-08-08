import db from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { isAdultCategory } from '../utils/helpers.js';

export const getProviderChannels = (req, res) => {
  try {
    const { type, page, limit, search } = req.query;
    const providerId = Number(req.params.id);

    if (!req.user.is_admin) {
        const provider = db.prepare('SELECT user_id FROM providers WHERE id = ?').get(providerId);
        if (!provider || provider.user_id !== req.user.id) return res.status(403).json({error: 'Access denied'});
    }

    const canViewChannelMetadata = req.user.is_admin || Number(req.user.provider_access) === 1;
    const channelFields = canViewChannelMetadata
      ? '*'
      : 'id, provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order, tv_archive, tv_archive_duration, mime_type, rating, rating_5based, added, plot, "cast", director, genre, releaseDate, youtube_trailer, episode_run_time';

    if (page || limit || search) {
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 50;
      const offset = (pageNum - 1) * limitNum;
      const searchTerm = (search || '').trim().toLowerCase();

      let baseQuery = 'FROM provider_channels WHERE provider_id = ?';
      const params = [providerId];

      if (type) {
        baseQuery += ' AND stream_type = ?';
        params.push(type);
      }

      if (searchTerm) {
        baseQuery += ' AND lower(name) LIKE ?';
        params.push(`%${searchTerm}%`);
      }

      const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
      const total = db.prepare(countQuery).get(...params).count;

      const dataQuery = `SELECT ${channelFields} ${baseQuery} ORDER BY original_sort_order ASC, name ASC LIMIT ? OFFSET ?`;
      const rows = db.prepare(dataQuery).all(...params, limitNum, offset);

      return res.json({
        channels: rows,
        total: total,
        page: pageNum,
        limit: limitNum
      });
    }

    let query = `SELECT ${channelFields} FROM provider_channels WHERE provider_id = ?`;
    const params = [providerId];

    if (type) {
        query += ' AND stream_type = ?';
        params.push(type);
    }

    query += ' ORDER BY original_sort_order ASC, name ASC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const getProviderCategories = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const type = req.query.type || 'live'; // 'live', 'movie', 'series'

    const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    if (!provider) return res.status(404).json({error: 'Provider not found'});

    if (!req.user.is_admin && provider.user_id !== req.user.id) {
        return res.status(403).json({error: 'Access denied'});
    }

    const decryptedPassword = decrypt(provider.password);

    let categories = [];
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(decryptedPassword)}`;
    let action = 'get_live_categories';

    if(type === 'movie') action = 'get_vod_categories';
    if(type === 'series') action = 'get_series_categories';

    try {
      const apiUrl = `${baseUrl}/player_api.php?${authParams}&action=${action}`;
      const resp = await fetchSafe(apiUrl);
      if (resp.ok) {
        categories = await resp.json();
      }
    } catch (e) {
      console.error('Failed to fetch categories:', e);
    }

    if (!categories || categories.length === 0) {
      return res.json([]);
    }

    let streamType = 'live';
    if(type === 'movie') streamType = 'movie';
    if(type === 'series') streamType = 'series';

    // ⚡ Bolt: Extract category IDs and use an IN clause to fetch channel counts only for relevant categories.
    // Also remove redundant DISTINCT and ORDER BY to reduce SQLite overhead.
    const categoryIds = categories.map(cat => Number(cat.category_id)).filter(id => id > 0);
    const localCatsMap = new Map();

    if (categoryIds.length > 0) {
      const placeholders = Array(categoryIds.length).fill('?').join(',');
      // ⚡ Bolt: Replace .all() with .iterate() to eliminate intermediate V8 array allocation overhead
      // 🎯 Why: Iterating over potentially massive datasets avoids unnecessary memory usage and garbage collection spikes.
      const stmt = db.prepare(`
        SELECT original_category_id,
               COUNT(*) as channel_count
        FROM provider_channels
        WHERE provider_id = ? AND stream_type = ? AND original_category_id IN (${placeholders})
        GROUP BY original_category_id
      `);

      for (const l of stmt.iterate(id, streamType, ...categoryIds)) {
        localCatsMap.set(Number(l.original_category_id), l);
      }
    }

    const merged = categories.map(cat => {
      const local = localCatsMap.get(Number(cat.category_id));
      const isAdult = isAdultCategory(cat.category_name);

      return {
        category_id: cat.category_id,
        category_name: cat.category_name,
        channel_count: local ? local.channel_count : 0,
        is_adult: isAdult,
        category_type: type
      };
    });

    res.json(merged);
  } catch (e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
};
