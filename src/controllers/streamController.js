import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import db from '../database/db.js';
import streamManager from '../services/streamManager.js';
import { getXtreamUser } from '../services/authService.js';
import { getBaseUrl, isSafeUrl, safeLookup, redactUrl, providerSourceKey } from '../utils/helpers.js';
import { fetchSafe } from '../utils/network.js';
import { episodeNameCache } from '../services/episodeCache.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';
import { decodeSeriesEpisodeId } from '../utils/seriesEpisodeId.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

// --- Prepared Statements (Lazy Initialization) ---

const stmts = {
    getChannel: null,
    getStat: null,
    updateStat: null,
    updateStatTimeOnly: null,
    insertStat: null,
    getSeriesAssignment: null,
    getSeriesEpisode: null,
    getProviderPool: null
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
      FROM authorized_user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      WHERE uc.id = ? AND cat.user_id = ?
    `);
    }
    return stmts.getChannel.get(streamId, userId);
}

function getStat(channelId) {
    if (!stmts.getStat) stmts.getStat = db.prepare('SELECT id, last_viewed FROM stream_stats WHERE channel_id = ?');
    return stmts.getStat.get(channelId);
}

function updateStat(lastViewed, id) {
    if (!stmts.updateStat) stmts.updateStat = db.prepare('UPDATE stream_stats SET views = views + 1, last_viewed = ? WHERE id = ?');
    return stmts.updateStat.run(lastViewed, id);
}

function updateStatTimeOnly(lastViewed, id) {
    if (!stmts.updateStatTimeOnly) stmts.updateStatTimeOnly = db.prepare('UPDATE stream_stats SET last_viewed = ? WHERE id = ?');
    return stmts.updateStatTimeOnly.run(lastViewed, id);
}

function insertStat(channelId, lastViewed) {
    if (!stmts.insertStat) stmts.insertStat = db.prepare('INSERT INTO stream_stats (channel_id, views, last_viewed) VALUES (?, 1, ?)');
    return stmts.insertStat.run(channelId, lastViewed);
}

function getSeriesEpisode(encodedId, userId) {
    const decoded = decodeSeriesEpisodeId(encodedId);
    if (!decoded) return null;

    if (!stmts.getSeriesAssignment) {
        stmts.getSeriesAssignment = db.prepare(`
          SELECT p.*, uc.id AS user_channel_id,
                 pc.remote_stream_id AS series_remote_id,
                 COALESCE(NULLIF(uc.custom_name, ''), pc.name) AS series_name
          FROM authorized_user_channels uc
          JOIN provider_channels pc ON pc.id = uc.provider_channel_id
          JOIN providers p ON p.id = pc.provider_id
          JOIN user_categories cat ON cat.id = uc.user_category_id
          WHERE uc.id = ? AND cat.user_id = ? AND pc.stream_type = 'series'
        `);
    }
    if (!stmts.getSeriesEpisode) {
        stmts.getSeriesEpisode = db.prepare(`
          SELECT season, episode_num, title, container_extension, logo
          FROM provider_series_episodes
          WHERE source_key = ? AND series_remote_id = ? AND remote_episode_id = ?
        `);
    }

    const assignment = stmts.getSeriesAssignment.get(decoded.assignmentId, userId);
    if (!assignment) return null;

    const episode = stmts.getSeriesEpisode.get(
      providerSourceKey(assignment.url),
      assignment.series_remote_id,
      decoded.remoteEpisodeId
    );
    return episode ? { ...assignment, ...episode, remote_episode_id: decoded.remoteEpisodeId } : null;
}

function getProviderPool(userId, providerUrl) {
    const base = providerUrl.replace(/\/+$/, '');
    // ⚡ Bolt: Cache prepared statement to eliminate SQLite compilation overhead on hot paths
    if (!stmts.getProviderPool) {
        stmts.getProviderPool = db.prepare('SELECT * FROM providers WHERE user_id = ? AND url LIKE ?');
    }
    // Fetch all providers for the same user with the same base url
    const providers = stmts.getProviderPool.all(userId, `${base}%`);
    // Filter strictly by normalized base URL in case of LIKE edge cases
    return providers.filter(p => p.url.replace(/\/+$/, '') === base);
}

async function findAvailableProvider(userId, originalProvider, reqIp, sessionName) {
    const pool = getProviderPool(userId, originalProvider.provider_url || originalProvider.url);
    const normalizedOriginal = originalProvider.id ? originalProvider : {
        id: originalProvider.provider_id,
        url: originalProvider.provider_url,
        username: originalProvider.provider_user,
        password: originalProvider.provider_pass,
        backup_urls: originalProvider.backup_urls,
        user_agent: originalProvider.user_agent,
        max_connections: originalProvider.provider_max_connections
    };

    // Cross-user assignments reach this point only through the authorized
    // assignment view. Keep the explicitly granted source provider available
    // even though it is intentionally absent from the user's provider pool.
    if (!pool.some(provider => provider.id === normalizedOriginal.id)) {
        pool.push(normalizedOriginal);
    }

    for (const p of pool) {
        let isSessionActive = false;

        // Handle provider object structure differences (from getChannel vs getProvider)
        const pId = p.id;
        const pMaxConnections = p.max_connections;

        // If the session is already active on this provider with this IP, it's free to use
        isSessionActive = await streamManager.isSessionActive(userId, reqIp, sessionName, pId);
        if (isSessionActive) {
            return p;
        }

        // Check if provider has reached max connections
        if (pMaxConnections > 0) {
            const active = await streamManager.getProviderConnectionCount(pId);
            if (active >= pMaxConnections) {
                continue; // This provider is full, try next
            }
        }

        // Found an available provider
        return p;
    }

    // No available provider found in pool, return null to indicate failure
    return null;
}

function shareGuestAllowed(user, channel) {
  if (!user.is_share_guest) return true;
  if (!user.allowed_channels.includes(channel.user_channel_id)) return false;

  const nowSec = Date.now() / 1000;
  return !((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end));
}

async function ensureUserConnectionAvailable(user, reqIp, sessionName, providerId) {
  if (!(user.max_connections > 0)) return true;

  const isSessionActiveForUser = await streamManager.isSessionActive(user.id, reqIp, sessionName, providerId);
  if (isSessionActiveForUser) return true;

  const active = await streamManager.getUserConnectionCount(user.id);
  return active < user.max_connections;
}

function applyProviderToChannel(channel, provider) {
  channel.provider_id = provider.id;
  channel.provider_url = provider.url;
  channel.provider_user = provider.username;
  channel.provider_pass = provider.password;
  channel.backup_urls = provider.backup_urls;
  channel.user_agent = provider.user_agent;
}

async function reserveChannelSession(connectionId, user, channel, req, res, sessionName, options = {}) {
  if (options.cleanupUser) {
    await streamManager.cleanupUser(user.id, req.ip);
  }

  if (!await ensureUserConnectionAvailable(user, req.ip, sessionName, channel.provider_id)) {
    res.status(403).send('Max connections reached');
    return false;
  }

  const availableProvider = await findAvailableProvider(user.id, channel, req.ip, sessionName);
  if (!availableProvider) {
    res.status(403).send('Provider max connections reached across all accounts');
    return false;
  }

  applyProviderToChannel(channel, availableProvider);

  if (options.delayMs) {
    await new Promise(resolve => setTimeout(resolve, options.delayMs));
  }

  await streamManager.add(connectionId, user, sessionName, req.ip, res, channel.provider_id);
  return true;
}

async function reserveProviderSession(connectionId, user, provider, req, res, sessionName) {
  if (!await ensureUserConnectionAvailable(user, req.ip, sessionName, provider.id)) {
    res.status(403).send('Max connections reached');
    return null;
  }

  const availableProvider = await findAvailableProvider(user.id, provider, req.ip, sessionName);
  if (!availableProvider) {
    res.status(403).send('Provider max connections reached across all accounts');
    return null;
  }

  await streamManager.add(connectionId, user, sessionName, req.ip, res, availableProvider.id);
  return availableProvider;
}

function recordStreamStat(channelId, label) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const existingStat = getStat(channelId);
    if (existingStat) {
      if (now - existingStat.last_viewed > 60) {
        updateStat(now, existingStat.id);
      } else {
        updateStatTimeOnly(now, existingStat.id);
      }
    } else {
      insertStat(channelId, now);
    }
  } catch (e) {
    console.error(`Error updating stream stats (${label}):`, e.message);
  }
}

function parseMetadata(metadata, label) {
  try {
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch(e) {
    console.warn(`Failed to parse metadata (${label}):`, e.message);
    return {};
  }
}

function buildStreamHeaders(userAgent, metadata, label) {
  const headers = {
    'User-Agent': userAgent || DEFAULT_USER_AGENT,
    'Connection': 'keep-alive'
  };

  const meta = parseMetadata(metadata, label);
  if (meta && meta.http_headers) {
    Object.assign(headers, meta.http_headers);
  }

  return { headers, meta };
}

function buildBackupUrls(backupUrls, buildUrl, label) {
  if (!backupUrls) return [];

  try {
    const backups = JSON.parse(backupUrls);
    return backups.map(bUrl => buildUrl(bUrl.replace(/\/+$/, '')));
  } catch(e) {
    console.warn(`Failed to parse backup_urls (${label}):`, e.message);
    return [];
  }
}

function formatTrackLabel(language, codec, fallback) {
  const parts = [language, codec].filter(Boolean);
  return parts.length ? parts.join(' - ') : fallback;
}

function parseFfmpegTracks(output) {
  const tracks = { audio: [], subtitles: [] };
  const re = /Stream #0:(\d+)(?:\(([^)]+)\))?:\s*(Audio|Subtitle):\s*([^,\n]+)/ig;
  let match;

  while ((match = re.exec(output)) !== null) {
    const index = Number(match[1]);
    const language = match[2] || '';
    const kind = match[3].toLowerCase();
    const codec = (match[4] || '').trim();
    const list = kind === 'audio' ? tracks.audio : tracks.subtitles;
    list.push({
      index,
      language,
      codec,
      label: formatTrackLabel(language, codec, `${kind} ${index}`)
    });
  }

  return tracks;
}

function probeTracksWithFfmpeg(url, headers) {
  return new Promise((resolve, reject) => {
    const binary = ffmpegPath || 'ffmpeg';
    const args = ['-hide_banner', ...buildFfmpegHeaderArgs(headers)];
    args.push('-i', url, '-t', '0.1', '-f', 'null', '-');

    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('ffmpeg probe timeout'));
    }, 15000);

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 128000) stderr = stderr.slice(-128000);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const tracks = parseFfmpegTracks(stderr);
      if (code !== 0 && tracks.audio.length === 0 && tracks.subtitles.length === 0) {
        reject(new Error('ffmpeg probe failed'));
        return;
      }
      resolve(tracks);
    });
  });
}

function buildFfmpegHeaderArgs(headers) {
  const headerStr = Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
  return headerStr.trim() ? ['-headers', headerStr] : [];
}

async function sendTrackInfo(res, remoteUrl, backupStreamUrls, headers) {
  const result = await fetchWithBackups(remoteUrl, backupStreamUrls, { headers, redirect: 'follow' });
  try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch {}
  const tracks = await probeTracksWithFfmpeg(result.successfulUrl || remoteUrl, headers);
  res.json(tracks);
}

async function sendSubtitleTrack(res, remoteUrl, backupStreamUrls, headers, req) {
  const subtitleTrack = selectedTrackIndex(req.query.subtitle_track);
  if (subtitleTrack === null) {
    res.sendStatus(400);
    return;
  }

  const result = await fetchWithBackups(remoteUrl, backupStreamUrls, { headers, redirect: 'follow' });
  try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch {}

  await new Promise((resolve, reject) => {
    const binary = ffmpegPath || 'ffmpeg';
    const args = ['-hide_banner', ...buildFfmpegHeaderArgs(headers), '-i', result.successfulUrl || remoteUrl, '-map', `0:${subtitleTrack}`, '-f', 'webvtt', '-'];
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    child.stdout.on('data', (chunk) => res.write(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 32000) stderr = stderr.slice(-32000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'ffmpeg subtitle extraction failed'));
        return;
      }
      res.end();
      resolve();
    });
    if (typeof res.on === 'function') {
      res.on('close', () => {
        try { child.kill('SIGKILL'); } catch {}
      });
    }
  });
}

function selectedTrackIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function hasSelectedVodTracks(req) {
  return selectedTrackIndex(req.query.audio_track) !== null || selectedTrackIndex(req.query.subtitle_track) !== null;
}

function buildVodOutputOptions(req) {
  const audioTrack = selectedTrackIndex(req.query.audio_track);
  const subtitleTrack = selectedTrackIndex(req.query.subtitle_track);
  const options = ['-map 0:v:0?'];

  if (audioTrack !== null) options.push('-map 0:' + audioTrack);
  else options.push('-map 0:a:0?');
  if (subtitleTrack !== null) options.push('-map 0:' + subtitleTrack);

  options.push('-c:v copy');
  options.push('-c:a aac');
  if (subtitleTrack !== null) options.push('-c:s mov_text');
  options.push('-f mp4');
  options.push('-movflags frag_keyframe+empty_moov');
  return options;
}

function createSafeCleanup(connectionId) {
  let cleanedUp = false;
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    streamManager.remove(connectionId);
  };
}

function attachResponseCleanup(req, res, cleanup) {
  if (req && typeof req.on === 'function') {
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }
  if (res && typeof res.on === 'function') {
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  }
}

function attachStreamHeartbeat(upstreamBody, connectionId) {
  if (!upstreamBody || typeof upstreamBody.on !== 'function') return;

  let lastTouch = 0;
  upstreamBody.on('data', () => {
    const now = Date.now();
    if (now - lastTouch < 30000) return;
    lastTouch = now;
    streamManager.touch(connectionId);
  });
}

// Helper for failover fetching
async function fetchWithBackups(primaryUrl, backupUrls, options) {
    const urls = [primaryUrl, ...(backupUrls || [])];
    let lastError = null;

    const fetchOptions = { ...options };
    delete fetchOptions.agent;
    delete fetchOptions.redirect;

    for (const u of urls) {
        if (!u) continue;
        try {
            const res = await fetchSafe(u, fetchOptions);
            if (res.ok) {
                return { response: res, successfulUrl: res.url || u };
            }
            res.body?.destroy?.();
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
    const mpdPath = req.params.mpdPath ?? req.params[0];
    const relativePath = Array.isArray(mpdPath) ? mpdPath.join('/') : (mpdPath || '');

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    let { headers, meta } = buildStreamHeaders(channel.user_agent, channel.metadata, 'MPD');

    let upstreamUrl = '';
    let backupStreamUrls = [];

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);

    const sessionName = `${channel.name} (DASH)`;
    const usesOriginalUrl = meta && meta.original_url;

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
        if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

        ({ headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'MPD'));
        channel.provider_pass = decrypt(channel.provider_pass);
        const base = channel.provider_url.replace(/\/+$/, '');
        upstreamUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;

        backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
            return `${bBase}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;
        }, 'MPD');
    }

    if (usesOriginalUrl && !await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

    recordStreamStat(channel.provider_channel_id, 'MPD');

    let upstream;
    try {
        const result = await fetchWithBackups(upstreamUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        upstream = result.response;
    } catch (e) {
        console.error(`MPD proxy failed: ${e.message}`);
        streamManager.localStreams.delete(connectionId);
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
    if (!res.headersSent) {
        streamManager.localStreams.delete(connectionId);
        streamManager.remove(connectionId);
        return res.sendStatus(500);
    }
    streamManager.remove(connectionId);
  }
};

// --- Live Stream Proxy ---
export const proxyLive = async (req, res) => {
  const connectionId = crypto.randomUUID();
  const cleanup = createSafeCleanup(connectionId);

  try {
    const streamId = Number(req.params.stream_id || 0);

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);

    let reqExt = 'ts';
    if (req.path.endsWith('.m3u8')) reqExt = 'm3u8';
    if (req.path.endsWith('.mp4')) reqExt = 'mp4';

    const wantsTranscode = (req.query.transcode === 'true');

    // Optimization: Skip streamManager overhead for playlist requests (unless transcoding)
    if (reqExt !== 'm3u8' || wantsTranscode) {
        if (!await reserveChannelSession(connectionId, user, channel, req, res, channel.name, {
          cleanupUser: true,
          delayMs: 100
        })) return;
    }

    recordStreamStat(channel.provider_channel_id, 'Live');

    channel.provider_pass = decrypt(channel.provider_pass);

    const remoteExt = (reqExt === 'm3u8' && !wantsTranscode) ? 'm3u8' : 'ts';

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${remoteExt}`;

    const backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${remoteExt}`;
    }, 'Live');

    const { headers: fetchHeaders } = buildStreamHeaders(channel.user_agent, channel.metadata, 'Live');

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
            cleanup();
          })
          .on('end', cleanup)
          .on('progress', () => streamManager.touch(connectionId));

        command.pipe(res, { end: true });

        streamManager.localStreams.set(connectionId, {
          destroy: () => {
            try { command.kill('SIGKILL'); } catch(e) {}
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
            try { if (!res.destroyed) res.destroy(); } catch(e) {}
          }
        });

        attachResponseCleanup(req, res, () => {
          try { command.kill('SIGKILL'); } catch(e) {}
          cleanup();
        });
        return;

      } catch (e) {
        console.error('Transcode setup error:', e.message);
        streamManager.localStreams.delete(connectionId);
        cleanup();
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
        streamManager.localStreams.delete(connectionId);
        cleanup();
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
          const payload = { u: absoluteUrl, c: channel.name, p: channel.provider_id };
          const encrypted = encrypt(JSON.stringify(payload));
          return `/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.ts?data=${encodeURIComponent(encrypted)}&base=${baseEncoded}${tokenParam}`;
        } catch (e) {
          return match;
        }
      }).replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1, baseUrl).toString();
          // Only encrypt the changing URL part
          const payload = { u: absoluteUrl, c: channel.name, p: channel.provider_id };
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

      cleanup();
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
    attachStreamHeartbeat(upstream.body, connectionId);

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
      if (!res.headersSent) {
          streamManager.localStreams.delete(connectionId);
          cleanup();
          return res.sendStatus(502);
      }
      cleanup();
    });

    attachResponseCleanup(req, res, cleanup);

  } catch (e) {
    console.error('Stream proxy error:', e.message);
    if (!res.headersSent) {
        streamManager.localStreams.delete(connectionId);
        cleanup();
        return res.sendStatus(500);
    }
    cleanup();
  }
};

// --- Segment Proxy ---
export const proxySegment = async (req, res) => {
  const connectionId = crypto.randomUUID();
  let channelName = null;
  let providerId = 0;

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
            if (payload.c) channelName = payload.c;
            if (payload.p) providerId = payload.p;
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

    let upstream;
    if (isOriginSafe) {
        upstream = await fetchSafe(targetUrl, { headers });
    } else {
        // If the original URL was unsafe (e.g. manually added loopback by an admin and we didn't check it)
        // Then we should probably not use fetchSafe because fetchSafe strictly forbids unsafe IPs.
        // However, falling back to unprotected fetch with follow-redirects opens up SSRF.
        // Given that fetchSafe is the secure way, we should use it consistently.
        // BUT to avoid breaking existing setups where isOriginSafe=false intentionally,
        // we'll keep the custom agent which blocks loopback via DNS, but we must handle redirects safely.
        // Since we don't have a manual redirect handler here for raw fetch, it's safer to just use fetchSafe anyway
        // or disable redirects for unsafe origins.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
            upstream = await fetch(targetUrl, {
              headers,
              signal: controller.signal,
              redirect: 'manual', // Don't follow redirects to arbitrary unsafe places
              agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent)
            });
        } finally {
            clearTimeout(timeoutId);
        }
    }

    if (!upstream.ok) {
       console.error(`⚠️ Segment upstream error: ${upstream.status} for ${targetUrl}`);
       return res.sendStatus(upstream.status);
    }

    if (channelName && providerId) {
        // Technically segment proxy is mostly stateless and shouldn't hit limits,
        // but it registers as a stream. It's better not to change providerId mid-stream,
        // so we use the providerId passed in the payload (which was the one chosen by the playlist generator).
        // For segments, pooling might have already happened when generating the M3U8,
        // or we just track it against the original provider.
        await streamManager.add(connectionId, user, `${channelName}`, req.ip, res, providerId, { dedupe: false });
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);

    upstream.body.on('error', (err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Segment stream error:', err.message);
      }
      if (channelName) streamManager.remove(connectionId);
    });

    req.on('close', () => {
       if (channelName) streamManager.remove(connectionId);
       if (upstream.body && !upstream.body.destroyed) upstream.body.destroy();
    });

  } catch (e) {
    console.error('Segment proxy error:', e.message);
    if (!res.headersSent) {
        if (channelName) streamManager.localStreams.delete(connectionId);
        if (channelName) streamManager.remove(connectionId);
        return res.sendStatus(500);
    }
    if (channelName) streamManager.remove(connectionId);
  }
};

// --- Movie Proxy ---
export const proxyMovie = async (req, res) => {
  const connectionId = crypto.randomUUID();
  const cleanup = createSafeCleanup(connectionId);

  try {
    const streamId = Number(req.params.stream_id || 0);
    const ext = req.params.ext;

    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);

    const sessionName = `${channel.name} (VOD)`;

    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const remoteUrl = `${base}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;

    const backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;
    }, 'Movie');

    const { headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'Movie');

    if (req.query.subtitle_format === 'vtt') {
      await sendSubtitleTrack(res, remoteUrl, backupStreamUrls, headers, req);
      return;
    }

    if (req.query.tracks === 'true') {
      await sendTrackInfo(res, remoteUrl, backupStreamUrls, headers);
      return;
    }

    if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

    recordStreamStat(channel.provider_channel_id, 'Movie');

    const shouldTranscode = req.query.transcode === 'true' || hasSelectedVodTracks(req);

    if (shouldTranscode) {
        const transcodeHeaders = { ...headers };
        delete transcodeHeaders['Range'];

        try {
            const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
                headers: transcodeHeaders,
                redirect: 'follow'
            });
            const successfulUrl = result.successfulUrl || remoteUrl;

            // Release the initial probe connection immediately so it doesn't count against provider limits
            try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch(e) {}

            // For VOD/MKV, ffmpeg needs to probe. It is much more reliable to let ffmpeg read the URL natively.
            // Convert headers object to an array of strings for FFmpeg -headers option
            const headerStr = Object.entries(transcodeHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Connection', 'keep-alive');

            const command = ffmpeg(successfulUrl)
              .inputOptions([
                '-headers', headerStr
              ])
              .outputOptions(buildVodOutputOptions(req))
              .on('error', (err) => {
                if (err.message && !err.message.includes('Output stream closed') && !err.message.includes('SIGKILL')) {
                   console.error('FFmpeg VOD error:', err.message);
                }
                cleanup();
              })
              .on('end', cleanup)
              .on('progress', () => streamManager.touch(connectionId));

            command.pipe(res, { end: true });

            attachResponseCleanup(req, res, () => {
                try { command.kill('SIGKILL'); } catch(e) {}
                cleanup();
            });
            return;

        } catch(e) {
            console.error('VOD Transcode error:', e);
            streamManager.localStreams.delete(connectionId);
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
        attachStreamHeartbeat(upstream.body, connectionId);

        streamManager.localStreams.set(connectionId, {
          destroy: () => {
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
            try { if (!res.destroyed) res.destroy(); } catch(e) {}
          }
        });

        upstream.body.on('error', (err) => {
          console.error('Movie stream error:', err.message);
          cleanup();
        });

        attachResponseCleanup(req, res, cleanup);
    } catch (e) {
        console.error('Movie proxy error:', e.message);
        if (!res.headersSent) {
            streamManager.localStreams.delete(connectionId);
            cleanup();
            return res.sendStatus(502);
        }
        cleanup();
    }

  } catch (e) {
    console.error('Movie proxy setup error:', e.message);
    if (!res.headersSent) {
        streamManager.localStreams.delete(connectionId);
        cleanup();
        return res.sendStatus(500);
    }
    cleanup();
  }
};

// --- Series Proxy ---
export const proxySeries = async (req, res) => {
  const connectionId = crypto.randomUUID();
  const cleanup = createSafeCleanup(connectionId);

  try {
    const epIdRaw = req.params.episode_id;
    const ext = req.params.ext;

    if (!decodeSeriesEpisodeId(epIdRaw)) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const seriesEpisode = getSeriesEpisode(epIdRaw, user.id);
    if (!seriesEpisode) return res.sendStatus(404);
    if (!shareGuestAllowed(user, seriesEpisode)) return res.sendStatus(403);

    const provider = seriesEpisode;
    const remoteEpisodeId = seriesEpisode.remote_episode_id;

    let sessionName = episodeNameCache.get(String(epIdRaw));
    if (!sessionName) {
      const epCode = `S${String(seriesEpisode.season || 0).padStart(2, '0')} E${String(seriesEpisode.episode_num || 0).padStart(2, '0')}`;
      sessionName = `${seriesEpisode.series_name || 'Series'} ${epCode}${seriesEpisode.title ? ` - ${seriesEpisode.title}` : ''}`;
    }

    const sourceProvider = { ...provider, password: decrypt(provider.password) };
    let base = sourceProvider.url.replace(/\/+$/, '');
    let remoteUrl = `${base}/series/${encodeURIComponent(sourceProvider.username)}/${encodeURIComponent(sourceProvider.password)}/${remoteEpisodeId}.${ext}`;
    let backupStreamUrls = buildBackupUrls(sourceProvider.backup_urls, (bBase) => {
        return `${bBase}/series/${encodeURIComponent(sourceProvider.username)}/${encodeURIComponent(sourceProvider.password)}/${remoteEpisodeId}.${ext}`;
    }, 'Series');
    let headers = {
      'User-Agent': sourceProvider.user_agent || DEFAULT_USER_AGENT,
      'Connection': 'keep-alive'
    };

    if (req.query.subtitle_format === 'vtt') {
      await sendSubtitleTrack(res, remoteUrl, backupStreamUrls, headers, req);
      return;
    }

    if (req.query.tracks === 'true') {
      await sendTrackInfo(res, remoteUrl, backupStreamUrls, headers);
      return;
    }

    const availableProvider = await reserveProviderSession(connectionId, user, provider, req, res, sessionName);
    if (!availableProvider) return;

    availableProvider.password = decrypt(availableProvider.password);

    base = availableProvider.url.replace(/\/+$/, '');
    remoteUrl = `${base}/series/${encodeURIComponent(availableProvider.username)}/${encodeURIComponent(availableProvider.password)}/${remoteEpisodeId}.${ext}`;
    backupStreamUrls = buildBackupUrls(availableProvider.backup_urls, (bBase) => {
        return `${bBase}/series/${encodeURIComponent(availableProvider.username)}/${encodeURIComponent(availableProvider.password)}/${remoteEpisodeId}.${ext}`;
    }, 'Series');
    headers = {
      'User-Agent': availableProvider.user_agent || DEFAULT_USER_AGENT,
      'Connection': 'keep-alive'
    };

    const shouldTranscode = req.query.transcode === 'true' || hasSelectedVodTracks(req);

    if (shouldTranscode) {
        const transcodeHeaders = { ...headers };
        delete transcodeHeaders['Range'];

        try {
            const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
                headers: transcodeHeaders,
                redirect: 'follow'
            });
            const successfulUrl = result.successfulUrl || remoteUrl;

            // Release the initial probe connection immediately so it doesn't count against provider limits
            try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch(e) {}

            // For Series/MKV, ffmpeg needs to probe. Let ffmpeg read the URL natively.
            const headerStr = Object.entries(transcodeHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Connection', 'keep-alive');

            const command = ffmpeg(successfulUrl)
              .inputOptions([
                '-headers', headerStr
              ])
              .outputOptions(buildVodOutputOptions(req))
              .on('error', (err) => {
                if (err.message && !err.message.includes('Output stream closed') && !err.message.includes('SIGKILL')) {
                   console.error('FFmpeg Series error:', err.message);
                }
                cleanup();
              })
              .on('end', cleanup)
              .on('progress', () => streamManager.touch(connectionId));

            command.pipe(res, { end: true });

            attachResponseCleanup(req, res, () => {
                try { command.kill('SIGKILL'); } catch(e) {}
                cleanup();
            });
            return;

        } catch(e) {
            console.error('Series Transcode error:', e);
            streamManager.localStreams.delete(connectionId);
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
        attachStreamHeartbeat(upstream.body, connectionId);

        streamManager.localStreams.set(connectionId, {
          destroy: () => {
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
            try { if (!res.destroyed) res.destroy(); } catch(e) {}
          }
        });

        upstream.body.on('error', (err) => {
          console.error('Series stream error:', err.message);
          cleanup();
        });

        attachResponseCleanup(req, res, cleanup);
    } catch(e) {
        console.error('Series proxy error:', e.message);
        if (!res.headersSent) {
            streamManager.localStreams.delete(connectionId);
            cleanup();
            return res.sendStatus(502);
        }
        cleanup();
    }

  } catch(e) {
    console.error('Series proxy setup error:', e.message);
    if (!res.headersSent) {
        streamManager.localStreams.delete(connectionId);
        cleanup();
        return res.sendStatus(500);
    }
    cleanup();
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

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);

    const sessionName = `${channel.name} (Timeshift)`;

    if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const reqExt = req.path.endsWith('.m3u8') ? 'm3u8' : 'ts';
    const remoteUrl = `${base}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${duration}/${start}/${channel.remote_stream_id}.${reqExt}`;

    const backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${duration}/${start}/${channel.remote_stream_id}.${reqExt}`;
    }, 'Timeshift');

    const { headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'Timeshift');

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
        streamManager.localStreams.delete(connectionId);
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
          const payload = { u: absoluteUrl, c: channel.name, p: channel.provider_id };
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

    streamManager.localStreams.set(connectionId, {
      destroy: () => {
        try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch(e) {}
        try { if (!res.destroyed) res.destroy(); } catch(e) {}
      }
    });

    upstream.body.on('error', (err) => {
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.type !== 'aborted') {
        console.error('Timeshift stream error:', err.message);
      }
      if (!res.headersSent) {
          streamManager.localStreams.delete(connectionId);
          streamManager.remove(connectionId);
          return res.sendStatus(502);
      }
      streamManager.remove(connectionId);
    });

    req.on('close', () => streamManager.remove(connectionId));

  } catch (e) {
    console.error('Timeshift proxy setup error:', e.message);
    if (!res.headersSent) {
        streamManager.localStreams.delete(connectionId);
        streamManager.remove(connectionId);
        return res.sendStatus(500);
    }
    streamManager.remove(connectionId);
  }
};
