import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import ffmpeg from 'fluent-ffmpeg';
import db from '../database/db.js';
import streamManager from '../services/streamManager.js';
import { getXtreamUser } from '../services/authService.js';
import { getBaseUrl, isSafeUrl, safeLookup } from '../utils/helpers.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

// --- Prepared Statements (Lazy Initialization) ---

const stmts = {
    getChannel: null,
    getStat: null,
    updateStat: null,
    insertStat: null,
    getProvider: null
};

function getChannel(streamId, userId) {
    if (!stmts.getChannel) {
        stmts.getChannel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        pc.id as provider_channel_id,
        pc.remote_stream_id,
        pc.name,
        pc.metadata,
        p.id as provider_id,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass,
        p.backup_urls,
        p.user_agent,
        p.max_connections as provider_max_connections
      FROM user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `);
    }
    return stmts.getChannel.get(streamId, userId);
}

function getStat(channelId) {
    if (!stmts.getStat) stmts.getStat = db.prepare('SELECT id FROM stream_stats WHERE channel_id = ?');
    return stmts.getStat.get(channelId);
}

function updateStat(lastViewed, id) {
    if (!stmts.updateStat) stmts.updateStat = db.prepare('UPDATE stream_stats SET views = views + 1, last_viewed = ? WHERE id = ?');
    return stmts.updateStat.run(lastViewed, id);
}

function insertStat(channelId, lastViewed) {
    if (!stmts.insertStat) stmts.insertStat = db.prepare('INSERT INTO stream_stats (channel_id, views, last_viewed) VALUES (?, 1, ?)');
    return stmts.insertStat.run(channelId, lastViewed);
}

function getProvider(id) {
    if (!stmts.getProvider) stmts.getProvider = db.prepare('SELECT * FROM providers WHERE id = ?');
    return stmts.getProvider.get(id);
}

// Redact credentials from upstream URLs before logging.
function redactUrl(url) {
  try {
    return url.replace(
      /\/(live|movie|series|timeshift)\/([^/]+)\/([^/]+)\//,
      '/$1/$2/********/'
    );
  } catch (e) {
    return '[redacted]';
  }
}

function isBrowser(req) {
  const ua = (req.headers['user-agent'] || '');
  if (!/Mozilla\//i.test(ua)) return false;
  return /Chrome|Firefox|Safari|Edge|OPR|Opera|Vivaldi|Brave|SamsungBrowser|UCBrowser|MSIE|Trident/i.test(ua);
}

// Helper for failover fetching
async function fetchWithBackups(primaryUrl, backupUrls, options) {
    const urls = [primaryUrl, ...(backupUrls || [])];
    let lastError = null;

    const fetchOptions = {
        ...options,
        agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent)
    };

    for (const u of urls) {
        if (!u) continue;
        try {
            const res = await fetch(u, fetchOptions);
            if (res.ok) {
                return { response: res, successfulUrl: u };
            }
            // If 404/403/407/etc, we might want to try backup? Yes.
            console.warn(`Connection failed to ${redactUrl(u)}: ${res.status}`);

            if (res.status === 407) {
                const authHeader = res.headers.get('proxy-authenticate') || res.headers.get('www-authenticate');
                console.warn(`Stream proxy error: HTTP 407 for ${redactUrl(u)}`);
                if (authHeader) {
                    console.warn(`Upstream requested authentication: ${authHeader}`);
                }
            }

            lastError = new Error(`HTTP ${res.status}`);
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.warn(`Connection error to ${redactUrl(u)}: ${e.message}`);
            lastError = e;
        }
    }
    throw lastError || new Error('All connection attempts failed');
}

// --- MPD Proxy ---
export const proxyMpd = async (req, res) => {
  const connectionId = crypto.randomUUID();
  try {
    const streamId = Number(req.params.stream_id || 0);
    const relativePath = req.params[0];

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    let meta = {};
    try {
        meta = typeof channel.metadata === 'string' ? JSON.parse(channel.metadata) : channel.metadata;
    } catch(e) {}

    const headers = {
      'User-Agent': channel.user_agent || DEFAULT_USER_AGENT,
      'Connection': 'keep-alive'
    };

    if (meta && meta.http_headers) {
        Object.assign(headers, meta.http_headers);
    }

    let upstreamUrl = '';
    let backupStreamUrls = [];

    if (meta && meta.original_url) {
        if (relativePath === 'manifest.mpd' || relativePath === '') {
            upstreamUrl = meta.original_url;
        } else {
            try {
              const urlObj = new URL(meta.original_url);
              const basePath = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);
              upstreamUrl = new URL(relativePath, urlObj.origin + basePath).toString();
            } catch(e) {
              return res.sendStatus(400);
            }
        }
    } else {
        channel.provider_pass = decrypt(channel.provider_pass);
        const base = channel.provider_url.replace(/\/+$/, '');
        upstreamUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;

        try {
            if (channel.backup_urls) {
                const backups = JSON.parse(channel.backup_urls);
                backupStreamUrls = backups.map(bUrl => {
                    const bBase = bUrl.replace(/\/+$/, '');
                    return `${bBase}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;
                });
            }
        } catch (e) {}
    }

    if (user.is_share_guest) {
        if (!user.allowed_channels.includes(channel.user_channel_id)) return res.sendStatus(403);
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) return res.sendStatus(403);
    }

    if (relativePath.endsWith('.mpd')) {
        const isSessionActive = await streamManager.isSessionActive(user.id, req.ip, `${channel.name} (DASH)`, channel.provider_id);
        if (!isSessionActive) {
            if (user.max_connections > 0) {
                const active = await streamManager.getUserConnectionCount(user.id);
                if (active >= user.max_connections) return res.status(403).send('Max connections reached');
            }

            if (channel.provider_max_connections > 0) {
                const active = await streamManager.getProviderConnectionCount(channel.provider_id);
                if (active >= channel.provider_max_connections) return res.status(403).send('Provider max connections reached');
            }
        }

        await streamManager.add(connectionId, user, `${channel.name} (DASH)`, req.ip, res, channel.provider_id);
        const now = Math.floor(Date.now() / 1000);
        const existingStat = getStat(channel.provider_channel_id);
        if (existingStat) {
          updateStat(now, existingStat.id);
        } else {
          insertStat(channel.provider_channel_id, now);
        }
    }

    let upstream, successfulUrl;
    try {
        const result = await fetchWithBackups(upstreamUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        upstream = result.response;
        successfulUrl = result.successfulUrl;
    } catch (e) {
        console.error(`MPD proxy failed: ${e.message}`);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
    }

    if (relativePath.endsWith('.mpd')) {
        const text = await upstream.text();
        const baseUrl = `${getBaseUrl(req)}/live/mpd/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/${streamId}/`;
        let newText = text.replace(/<BaseURL>http[^<]+<\/BaseURL>/g, `<BaseURL>${baseUrl}</BaseURL>`);
        res.setHeader('Content-Type', 'application/dash+xml');
        res.send(newText);
        streamManager.remove(connectionId);
        return;
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

    req.on('close', () => {
       streamManager.remove(connectionId);
       if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
    });

  } catch (e) {
    console.error('MPD proxy error:', e);
    streamManager.remove(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
};

// --- Live Stream Proxy ---
export const proxyLive = async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (user.is_share_guest) {
        if (!user.allowed_channels.includes(channel.user_channel_id)) return res.sendStatus(403);
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) return res.sendStatus(403);
    }

    let reqExt = 'ts';
    if (req.path.endsWith('.m3u8')) reqExt = 'm3u8';
    if (req.path.endsWith('.mp4')) reqExt = 'mp4';

    const wantsTranscode = (req.query.transcode === 'true');

    // Optimization: Skip streamManager overhead for playlist requests (unless transcoding)
    if (reqExt !== 'm3u8' || wantsTranscode) {
        await streamManager.cleanupUser(user.id, req.ip);

        if (user.max_connections > 0) {
            const active = await streamManager.getUserConnectionCount(user.id);
            if (active >= user.max_connections) return res.status(403).send('Max connections reached');
        }

        if (channel.provider_max_connections > 0) {
            const active = await streamManager.getProviderConnectionCount(channel.provider_id);
            if (active >= channel.provider_max_connections) return res.status(403).send('Provider max connections reached');
        }

        await new Promise(resolve => setTimeout(resolve, 100));
        await streamManager.add(connectionId, user, channel.name, req.ip, res, channel.provider_id);
    }

    const now = Math.floor(Date.now() / 1000);
    const existingStat = getStat(channel.provider_channel_id);
    if (existingStat) {
      updateStat(now, existingStat.id);
    } else {
      insertStat(channel.provider_channel_id, now);
    }

    channel.provider_pass = decrypt(channel.provider_pass);

    const remoteExt = (reqExt === 'm3u8' && !wantsTranscode) ? 'm3u8' : 'ts';

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${remoteExt}`;

    let backupStreamUrls = [];
    try {
        if (channel.backup_urls) {
            const backups = JSON.parse(channel.backup_urls);
            backupStreamUrls = backups.map(bUrl => {
                const bBase = bUrl.replace(/\/+$/, '');
                return `${bBase}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${remoteExt}`;
            });
        }
    } catch(e) {}

    let meta = {};
    try {
        meta = typeof channel.metadata === 'string' ? JSON.parse(channel.metadata) : channel.metadata;
    } catch(e) {}

    const fetchHeaders = {
        'User-Agent': channel.user_agent || DEFAULT_USER_AGENT,
        'Connection': 'keep-alive'
    };

    if (meta && meta.http_headers) {
        Object.assign(fetchHeaders, meta.http_headers);
    }

    const shouldTranscode = (req.query.transcode === 'true') || (reqExt === 'mp4');

    if (shouldTranscode) {
      try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
          headers: fetchHeaders,
          redirect: 'follow'
        });
        const upstream = result.response;

        const isMp4 = (reqExt === 'mp4');
        const outputFormat = isMp4 ? 'mp4' : 'mpegts';
        const contentType = isMp4 ? 'video/mp4' : 'video/mp2t';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Connection', 'keep-alive');

        const outputOptions = [
            '-c:v copy',
            '-c:a aac',
            '-b:a 128k',
            `-f ${outputFormat}`
        ];

        if (isMp4) {
            outputOptions.push('-movflags frag_keyframe+empty_moov');
        }

        const command = ffmpeg(upstream.body)
          .inputFormat('mpegts')
          .outputOptions(outputOptions)
          .on('error', (err) => {
            if (err.message && !err.message.includes('Output stream closed') && !err.message.includes('SIGKILL')) {
               console.error('FFmpeg error:', err.message);
            }
            streamManager.remove(connectionId);
          })
          .on('end', () => {
            streamManager.remove(connectionId);
          });

        command.pipe(res, { end: true });

        streamManager.localStreams.set(connectionId, {
          destroy: () => {
            try { command.kill('SIGKILL'); } catch(e) {}
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
            try { if (!res.destroyed) res.destroy(); } catch(e) {}
          }
        });

        req.on('close', () => streamManager.remove(connectionId));
        return;

      } catch (e) {
        console.error('Transcode setup error:', e.message);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
      }
    }

    let upstream, successfulUrl;
    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers: fetchHeaders,
            redirect: 'follow'
        });
        upstream = result.response;
        successfulUrl = result.successfulUrl;
    } catch(e) {
        console.error(`Stream proxy error: ${e.message} for ${redactUrl(remoteUrl)}`);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
    }

    const cookies = upstream.headers.get('set-cookie');

    if (reqExt === 'm3u8') {
      const text = await upstream.text();
      const baseUrl = upstream.url || successfulUrl;
      const tokenParam = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';

      const isProviderSafe = await isSafeUrl(channel.provider_url);

      const headersToForward = { ...fetchHeaders };
      if (cookies) headersToForward['Cookie'] = cookies;

      // Optimization: Encrypt headers and safe-check once
      const basePayload = { h: headersToForward, s: isProviderSafe };
      const baseEncrypted = encrypt(JSON.stringify(basePayload));
      const baseEncoded = encodeURIComponent(baseEncrypted);

      const newText = text.replace(/^(?!#)(.+)$/gm, (match) => {
        const line = match.trim();
        if (!line) return match;
        try {
          const absoluteUrl = new URL(line, baseUrl).toString();
          // Only encrypt the changing URL part
          const payload = { u: absoluteUrl };
          const encrypted = encrypt(JSON.stringify(payload));
          return `/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.ts?data=${encodeURIComponent(encrypted)}&base=${baseEncoded}${tokenParam}`;
        } catch (e) {
          return match;
        }
      }).replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1, baseUrl).toString();
          // Only encrypt the changing URL part
          const payload = { u: absoluteUrl };
          const encrypted = encrypt(JSON.stringify(payload));
          return `URI="/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.key?data=${encodeURIComponent(encrypted)}&base=${baseEncoded}${tokenParam}"`;
        } catch (e) {
          return match;
        }
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(newText);

      if (reqExt !== 'm3u8') {
          streamManager.remove(connectionId);
      }
      return;
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

    streamManager.localStreams.set(connectionId, {
      destroy: () => {
        try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
        try { if (!res.destroyed) res.destroy(); } catch(e) {}
      }
    });

    upstream.body.on('error', (err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Stream error:', err.message);
      }
      streamManager.remove(connectionId);
      if (!res.headersSent) res.sendStatus(502);
    });

    req.on('close', () => streamManager.remove(connectionId));

  } catch (e) {
    console.error('Stream proxy error:', e.message);
    streamManager.remove(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
};

// --- Segment Proxy ---
export const proxySegment = async (req, res) => {
  try {
    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    if (user.is_share_guest) {
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) {
            return res.sendStatus(403);
        }
    }

    let targetUrl;
    let headers = {
        'User-Agent': DEFAULT_USER_AGENT,
        'Connection': 'keep-alive'
    };

    let isOriginSafe = true;

    // Handle 'base' param for optimized static headers/settings
    if (req.query.base) {
        try {
            const decryptedBase = decrypt(req.query.base);
            if (decryptedBase) {
                const basePayload = JSON.parse(decryptedBase);
                if (basePayload.h) Object.assign(headers, basePayload.h);
                if (basePayload.s === false) isOriginSafe = false;
            }
        } catch(e) {}
    }

    if (req.query.data) {
        try {
            const decrypted = decrypt(req.query.data);
            if (!decrypted) return res.sendStatus(400);

            const payload = JSON.parse(decrypted);
            if (payload.u) targetUrl = payload.u;
            // Merge per-segment overrides (if any, legacy support)
            if (payload.h) Object.assign(headers, payload.h);
            if (payload.s !== undefined) {
                 if (payload.s === false) isOriginSafe = false;
            }
        } catch(e) {
            return res.sendStatus(400);
        }
    }

    if (!targetUrl) return res.sendStatus(400);

    if (isOriginSafe) {
        if (!(await isSafeUrl(targetUrl))) {
            return res.sendStatus(403);
        }
    }

    const upstream = await fetch(targetUrl, {
      headers,
      redirect: 'follow',
      agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent)
    });

    if (!upstream.ok) {
       console.error(`⚠️ Segment upstream error: ${upstream.status} for ${targetUrl}`);
       return res.sendStatus(upstream.status);
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);
  } catch (e) {
    console.error('Segment proxy error:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
};

// --- Movie Proxy ---
export const proxyMovie = async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);
    const ext = req.params.ext;

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (user.is_share_guest) {
        if (!user.allowed_channels.includes(channel.user_channel_id)) return res.sendStatus(403);
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) return res.sendStatus(403);
    }

    const isSessionActive = await streamManager.isSessionActive(user.id, req.ip, `${channel.name} (VOD)`, channel.provider_id);
    if (!isSessionActive) {
        if (user.max_connections > 0) {
            const active = await streamManager.getUserConnectionCount(user.id);
            if (active >= user.max_connections) return res.status(403).send('Max connections reached');
        }

        if (channel.provider_max_connections > 0) {
            const active = await streamManager.getProviderConnectionCount(channel.provider_id);
            if (active >= channel.provider_max_connections) return res.status(403).send('Provider max connections reached');
        }
    }

    await streamManager.add(connectionId, user, `${channel.name} (VOD)`, req.ip, res, channel.provider_id);

    const now = Math.floor(Date.now() / 1000);
    const existingStat = getStat(channel.provider_channel_id);
    if (existingStat) {
      updateStat(now, existingStat.id);
    } else {
      insertStat(channel.provider_channel_id, now);
    }

    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;

    let backupStreamUrls = [];
    try {
        if (channel.backup_urls) {
            const backups = JSON.parse(channel.backup_urls);
            backupStreamUrls = backups.map(bUrl => {
                const bBase = bUrl.replace(/\/+$/, '');
                return `${bBase}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;
            });
        }
    } catch(e) {}

    let meta = {};
    try {
        meta = typeof channel.metadata === 'string' ? JSON.parse(channel.metadata) : channel.metadata;
    } catch(e) {}

    const headers = {
        'User-Agent': channel.user_agent || DEFAULT_USER_AGENT,
        'Connection': 'keep-alive'
    };

    if (meta && meta.http_headers) {
        Object.assign(headers, meta.http_headers);
    }

    const shouldTranscode = (req.query.transcode === 'true') || (isBrowser(req) && (ext === 'mkv' || ext === 'avi'));

    if (shouldTranscode) {
        const transcodeHeaders = { ...headers };
        delete transcodeHeaders['Range'];

        try {
            const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
                headers: transcodeHeaders,
                redirect: 'follow'
            });
            const upstream = result.response;

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Connection', 'keep-alive');

            const command = ffmpeg(upstream.body)
              .outputOptions([
                '-c:v copy',
                '-c:a aac',
                '-f mp4',
                '-movflags frag_keyframe+empty_moov'
              ])
              .on('error', (err) => {
                if (err.message && !err.message.includes('Output stream closed') && !err.message.includes('SIGKILL')) {
                   console.error('FFmpeg VOD error:', err.message);
                }
                streamManager.remove(connectionId);
              })
              .on('end', () => streamManager.remove(connectionId));

            command.pipe(res, { end: true });

            req.on('close', () => {
                command.kill('SIGKILL');
                streamManager.remove(connectionId);
            });
            return;

        } catch(e) {
            console.error('VOD Transcode error:', e);
            streamManager.remove(connectionId);
            return res.sendStatus(500);
        }
    }

    if (req.headers.range) {
        headers['Range'] = req.headers.range;
    }

    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        const upstream = result.response;

        res.status(upstream.status);

        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);

        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);

        const acceptRanges = upstream.headers.get('accept-ranges');
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

        upstream.body.pipe(res);

        upstream.body.on('error', (err) => {
          console.error('Movie stream error:', err.message);
          streamManager.remove(connectionId);
        });

        req.on('close', () => {
          streamManager.remove(connectionId);
          if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
        });
    } catch (e) {
        console.error('Movie proxy error:', e.message);
        streamManager.remove(connectionId);
        if (!res.headersSent) res.sendStatus(502);
    }

  } catch (e) {
    console.error('Movie proxy setup error:', e.message);
    streamManager.remove(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
};

// --- Series Proxy ---
export const proxySeries = async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const epIdRaw = Number(req.params.episode_id || 0);
    const ext = req.params.ext;

    if (!epIdRaw) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const OFFSET = 1000000000;
    const providerId = Math.floor(epIdRaw / OFFSET);
    const remoteEpisodeId = epIdRaw % OFFSET;

    if (!providerId || !remoteEpisodeId) return res.sendStatus(404);

    const provider = getProvider(providerId);
    if (!provider) return res.sendStatus(404);

    if (user.is_share_guest) return res.sendStatus(403);

    const isSessionActive = await streamManager.isSessionActive(user.id, req.ip, `Series Episode ${remoteEpisodeId}`, provider.id);
    if (!isSessionActive) {
        if (user.max_connections > 0) {
            const active = await streamManager.getUserConnectionCount(user.id);
            if (active >= user.max_connections) return res.status(403).send('Max connections reached');
        }

        if (provider.max_connections > 0) {
            const active = await streamManager.getProviderConnectionCount(provider.id);
            if (active >= provider.max_connections) return res.status(403).send('Provider max connections reached');
        }
    }

    await streamManager.add(connectionId, user, `Series Episode ${remoteEpisodeId}`, req.ip, res, provider.id);

    provider.password = decrypt(provider.password);

    const base = provider.url.replace(/\/+$/, '');
    const remoteUrl = `${base}/series/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${remoteEpisodeId}.${ext}`;

    let backupStreamUrls = [];
    try {
        if (provider.backup_urls) {
            const backups = JSON.parse(provider.backup_urls);
            backupStreamUrls = backups.map(bUrl => {
                const bBase = bUrl.replace(/\/+$/, '');
                return `${bBase}/series/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${remoteEpisodeId}.${ext}`;
            });
        }
    } catch(e) {}

    const headers = {
      'User-Agent': provider.user_agent || DEFAULT_USER_AGENT,
      'Connection': 'keep-alive'
    };

    if (req.headers.range) {
        headers['Range'] = req.headers.range;
    }

    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        const upstream = result.response;

        res.status(upstream.status);

        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);

        const acceptRanges = upstream.headers.get('accept-ranges');
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);

        upstream.body.pipe(res);

        upstream.body.on('error', (err) => {
          console.error('Series stream error:', err.message);
          streamManager.remove(connectionId);
        });

        req.on('close', () => {
          streamManager.remove(connectionId);
          if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
        });
    } catch(e) {
        console.error('Series proxy error:', e.message);
        streamManager.remove(connectionId);
        if (!res.headersSent) res.sendStatus(502);
    }

  } catch(e) {
    console.error('Series proxy setup error:', e.message);
    streamManager.remove(connectionId);
    if (!res.headersSent) res.sendStatus(500);
  }
};

// --- Timeshift Proxy ---
export const proxyTimeshift = async (req, res) => {
  const connectionId = crypto.randomUUID();

  try {
    const streamId = Number(req.params.stream_id || 0);
    const duration = req.params.duration;
    const start = req.params.start;

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (user.is_share_guest) {
        if (!user.allowed_channels.includes(channel.user_channel_id)) return res.sendStatus(403);
        const nowSec = Date.now() / 1000;
        if ((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end)) return res.sendStatus(403);
    }

    const isSessionActive = await streamManager.isSessionActive(user.id, req.ip, `${channel.name} (Timeshift)`, channel.provider_id);
    if (!isSessionActive) {
        if (user.max_connections > 0) {
            const active = await streamManager.getUserConnectionCount(user.id);
            if (active >= user.max_connections) return res.status(403).send('Max connections reached');
        }

        if (channel.provider_max_connections > 0) {
            const active = await streamManager.getProviderConnectionCount(channel.provider_id);
            if (active >= channel.provider_max_connections) return res.status(403).send('Provider max connections reached');
        }
    }

    await streamManager.add(connectionId, user, `${channel.name} (Timeshift)`, req.ip, res, channel.provider_id);

    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const reqExt = req.path.endsWith('.m3u8') ? 'm3u8' : 'ts';
    const remoteUrl = `${base}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${duration}/${start}/${channel.remote_stream_id}.${reqExt}`;

    let backupStreamUrls = [];
    try {
        if (channel.backup_urls) {
            const backups = JSON.parse(channel.backup_urls);
            backupStreamUrls = backups.map(bUrl => {
                const bBase = bUrl.replace(/\/+$/, '');
                return `${bBase}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${duration}/${start}/${channel.remote_stream_id}.${reqExt}`;
            });
        }
    } catch(e) {}

    let meta = {};
    try {
        meta = typeof channel.metadata === 'string' ? JSON.parse(channel.metadata) : channel.metadata;
    } catch(e) {}

    const headers = {
        'User-Agent': channel.user_agent || DEFAULT_USER_AGENT,
        'Connection': 'keep-alive'
    };

    if (meta && meta.http_headers) {
        Object.assign(headers, meta.http_headers);
    }

    let upstream, successfulUrl;
    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        upstream = result.response;
        successfulUrl = result.successfulUrl;
    } catch(e) {
        console.error(`Timeshift proxy error: ${e.message}`);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
    }

    if (reqExt === 'm3u8') {
      const text = await upstream.text();
      const baseUrl = upstream.url || successfulUrl;
      const tokenParam = req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';

      const isProviderSafe = await isSafeUrl(channel.provider_url);

      const headersToForward = { ...headers };
      const cookies = upstream.headers.get('set-cookie');
      if (cookies) headersToForward['Cookie'] = cookies;

      // Optimization: Encrypt headers and safe-check once
      const basePayload = { h: headersToForward, s: isProviderSafe };
      const baseEncrypted = encrypt(JSON.stringify(basePayload));
      const baseEncoded = encodeURIComponent(baseEncrypted);

      const newText = text.replace(/^(?!#)(.+)$/gm, (match) => {
        const line = match.trim();
        if (!line) return match;
        try {
          const absoluteUrl = new URL(line, baseUrl).toString();
          // Only encrypt the changing URL part
          const payload = { u: absoluteUrl };
          const encrypted = encrypt(JSON.stringify(payload));
          return `/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.ts?data=${encodeURIComponent(encrypted)}&base=${baseEncoded}${tokenParam}`;
        } catch (e) {
          return match;
        }
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(newText);

      streamManager.remove(connectionId);
      return;
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    upstream.body.pipe(res);

    upstream.body.on('error', (err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Timeshift stream error:', err.message);
      }
      streamManager.remove(connectionId);
      if (!res.headersSent) {
        res.sendStatus(500);
      }
    });

    req.on('close', () => {
      streamManager.remove(connectionId);
      if (upstream.body && !upstream.body.destroyed) {
        upstream.body.destroy();
      }
    });

  } catch (e) {
    console.error('Timeshift proxy setup error:', e.message);
    streamManager.remove(connectionId);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
};
