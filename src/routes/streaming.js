import express from 'express';
import db from '../config/database.js';
import { authUser } from '../services/authService.js';
import { EPG_CACHE_DIR } from '../config/paths.js';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';

const router = express.Router();

// === Xtream API ===
router.get('/player_api.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();
    const action = (req.query.action || '').trim();

    const user = await authUser(username, password);
    if (!user) {
      return res.json({user_info: {auth: 0, message: 'Invalid credentials'}});
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
          port: '3000',
          https_port: '',
          server_protocol: 'http',
          rtmp_port: '',
          timezone: 'Europe/Berlin',
          timestamp_now: now,
          time_now: new Date(now * 1000).toISOString().slice(0, 19).replace('T', ' '),
          process: true
        }
      });
    }

    if (action === 'get_live_categories') {
      const cats = db.prepare('SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order').all(user.id);
      const result = cats.map(c => ({
        category_id: String(c.id),
        category_name: c.name,
        parent_id: 0
      }));
      return res.json(result);
    }

    if (action === 'get_live_streams') {
      const rows = db.prepare(`
        SELECT uc.id as user_channel_id, uc.user_category_id, pc.*, cat.is_adult as category_is_adult
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ?
        ORDER BY uc.sort_order
      `).all(user.id);

      const result = await Promise.all(rows.map(async (ch, i) => {
        // Use direct picon URL - no caching needed
        let iconUrl = ch.logo || '';

        return {
          num: i + 1,
          name: ch.name,
          stream_type: 'live',
          stream_id: Number(ch.user_channel_id),
          stream_icon: iconUrl,
          epg_channel_id: ch.epg_channel_id || '',
          added: now.toString(),
          is_adult: ch.category_is_adult || 0,
          category_id: String(ch.user_category_id),
          category_ids: [Number(ch.user_category_id)],
          custom_sid: null,
          tv_archive: 0,
          direct_source: '',
          tv_archive_duration: 0
        };
      }));
      return res.json(result);
    }

    if (['get_vod_categories', 'get_series_categories', 'get_vod_streams', 'get_series'].includes(action)) {
      return res.json([]);
    }

    res.status(400).json([]);
  } catch (e) {
    console.error('player_api error:', e);
    res.status(500).json([]);
  }
});

// === Stream Proxy ===
router.get('/live/:username/:password/:stream_id.ts', async (req, res) => {
  try {
    const username = (req.params.username || '').trim();
    const password = (req.params.password || '').trim();
    const streamId = Number(req.params.stream_id || 0);

    if (!streamId) return res.sendStatus(404);

    const user = await authUser(username, password);
    if (!user) return res.sendStatus(401);

    const channel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.remote_stream_id,
        pc.name,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `).get(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.ts`;

    // Fetch with optimized settings for streaming
    const upstream = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'IPTV-Manager/2.5.1',
        'Connection': 'keep-alive'
      },
      // Don't follow redirects automatically for better control
      redirect: 'follow'
      // No timeout - streams can run indefinitely
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`Stream proxy error: ${upstream.status} ${upstream.statusText} for ${remoteUrl}`);
      return res.sendStatus(502);
    }

    // Set optimal headers for streaming
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    // Copy content-length if available
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Stream the response with error handling
    upstream.body.pipe(res);

    // Handle stream errors (only log real errors, not normal disconnects)
    upstream.body.on('error', (err) => {
      // Only log if it's not a normal client disconnect
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Stream error:', err.message);
      }
      if (!res.headersSent) {
        res.sendStatus(502);
      }
    });

    // Handle client disconnect gracefully
    req.on('close', () => {
      if (upstream.body && !upstream.body.destroyed) {
        upstream.body.destroy();
      }
    });

  } catch (e) {
    console.error('Stream proxy error:', e.message);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

// === XMLTV ===
router.get('/xmltv.php', async (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    const password = (req.query.password || '').trim();

    const user = await authUser(username, password);
    if (!user) return res.sendStatus(401);

    // Collect all EPG data from cache
    const epgFiles = [];

    // Get provider EPG files
    const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }

    // Get EPG source files
    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    for (const source of sources) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }

    if (epgFiles.length === 0) {
      // Fallback to provider EPG URL if no cache
      const provider = db.prepare("SELECT * FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != '' LIMIT 1").get();
      if (provider && provider.epg_url) {
        const upstream = await fetch(provider.epg_url);
        if (upstream.ok && upstream.body) {
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return upstream.body.pipe(res);
        }
      }
      return res.status(404).send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
    }

    // Merge all EPG files
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

    for (const file of epgFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        // Extract content between <tv> tags
        const match = content.match(/<tv[^>]*>([\s\S]*)<\/tv>/);
        if (match && match[1]) {
          res.write(match[1]);
        }
      } catch (e) {
        console.error(`Error reading EPG file ${file}:`, e.message);
      }
    }

    res.write('</tv>');
    res.end();
  } catch (e) {
    console.error('xmltv error:', e.message);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
});

export default router;
