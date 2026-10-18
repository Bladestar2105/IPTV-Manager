import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import db from '../database/db.js';
import streamManager from '../services/streamManager.js';
import { providerSourceKey, redactUrl } from '../utils/helpers.js';
import { fetchSafe, discardBody, readBodyWithLimit } from '../utils/network.js';
import { isMp4Prefix, isTransportStreamPrefix, TRANSPORT_PREFIX_BYTES } from '../utils/clientMp4.js';
import { validateClientTtml } from '../utils/clientTtml.js';
import { createClientResourceUrl } from '../services/clientResourceService.js';
import { withUpstreamCookies } from '../utils/clientCookies.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';
import {
  decodeSeriesEpisodeId,
  SERIES_EPISODE_ALIAS_MIN,
  SERIES_EPISODE_OFFSET
} from '../utils/seriesEpisodeId.js';

// --- Prepared Statements (Lazy Initialization) ---

const stmts = {
    getChannel: null,
    getStat: null,
    updateStat: null,
    updateStatTimeOnly: null,
    insertStat: null,
    getSeriesAlias: null,
    getLegacySeriesAssignments: null,
    getSeriesEpisode: null,
    getProviderPool: null
};

export function getChannel(streamId, userId) {
    if (!stmts.getChannel) {
        stmts.getChannel = db.prepare(`
      SELECT
        uc.id as user_channel_id,
        uc.granted_by_admin,
        pc.id as provider_channel_id,
        pc.remote_stream_id,
        pc.name,
        pc.metadata,
        pc.mime_type,
        p.id as provider_id,
        p.url as provider_url,
        p.username as provider_user,
        p.password as provider_pass,
        p.backup_urls,
        p.user_agent,
        p.max_connections as provider_max_connections,
        p.timeshift_timezone,
        pc.tv_archive,
        pc.tv_archive_duration,
        COALESCE(map.epg_channel_id, pc.epg_channel_id) AS epg_channel_id,
        cat.user_id as category_owner_id,
        p.user_id as provider_owner_id
      FROM authorized_user_channels uc
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      JOIN user_categories cat ON cat.id = uc.user_category_id
      LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
      WHERE uc.id = ? AND cat.user_id = ?
    `);
    }
    return stmts.getChannel.get(streamId, userId);
}

export function getStat(channelId) {
    if (!stmts.getStat) stmts.getStat = db.prepare('SELECT id, last_viewed FROM stream_stats WHERE channel_id = ?');
    return stmts.getStat.get(channelId);
}

export function updateStat(lastViewed, id) {
    if (!stmts.updateStat) stmts.updateStat = db.prepare('UPDATE stream_stats SET views = views + 1, last_viewed = ? WHERE id = ?');
    return stmts.updateStat.run(lastViewed, id);
}

export function updateStatTimeOnly(lastViewed, id) {
    if (!stmts.updateStatTimeOnly) stmts.updateStatTimeOnly = db.prepare('UPDATE stream_stats SET last_viewed = ? WHERE id = ?');
    return stmts.updateStatTimeOnly.run(lastViewed, id);
}

export function insertStat(channelId, lastViewed) {
    if (!stmts.insertStat) stmts.insertStat = db.prepare('INSERT INTO stream_stats (channel_id, views, last_viewed) VALUES (?, 1, ?)');
    return stmts.insertStat.run(channelId, lastViewed);
}

export function getSeriesEpisode(encodedId, userId) {
    const publicId = Number(encodedId);
    if (!Number.isSafeInteger(publicId) || publicId <= 0) return null;

    if (!stmts.getSeriesEpisode) {
        stmts.getSeriesEpisode = db.prepare(`
          SELECT season, episode_num, title, container_extension, logo
          FROM provider_series_episodes
          WHERE source_key = ? AND series_remote_id = ? AND remote_episode_id = ?
        `);
    }

    if (publicId >= SERIES_EPISODE_ALIAS_MIN && publicId < SERIES_EPISODE_OFFSET) {
        if (!stmts.getSeriesAlias) {
            stmts.getSeriesAlias = db.prepare(`
              SELECT a.source_key AS episode_source_key, a.remote_episode_id,
                     p.*, uc.id AS user_channel_id, uc.granted_by_admin,
                     cat.user_id AS category_owner_id,
                     p.user_id AS provider_owner_id,
                     pc.remote_stream_id AS series_remote_id,
                     COALESCE(NULLIF(uc.custom_name, ''), pc.name) AS series_name
              FROM series_episode_aliases a
              JOIN authorized_user_channels uc ON uc.id = a.user_channel_id
              JOIN provider_channels pc ON pc.id = uc.provider_channel_id
              JOIN providers p ON p.id = pc.provider_id
              JOIN user_categories cat ON cat.id = uc.user_category_id
              WHERE a.id = ? AND cat.user_id = ? AND pc.stream_type = 'series'
                AND pc.remote_stream_id = a.series_remote_id
            `);
        }

        const assignment = stmts.getSeriesAlias.get(publicId, userId);
        if (!assignment || providerSourceKey(assignment.url) !== assignment.episode_source_key) return null;
        const episode = stmts.getSeriesEpisode.get(
          assignment.episode_source_key,
          assignment.series_remote_id,
          assignment.remote_episode_id
        );
        return episode ? { ...assignment, ...episode } : null;
    }
    if (publicId < SERIES_EPISODE_OFFSET) return null;

    const decoded = decodeSeriesEpisodeId(publicId);
    if (!decoded) return null;
    if (!stmts.getLegacySeriesAssignments) {
        stmts.getLegacySeriesAssignments = db.prepare(`
          SELECT p.*, uc.id AS user_channel_id, uc.granted_by_admin,
                 cat.user_id AS category_owner_id,
                 p.user_id AS provider_owner_id,
                 pc.remote_stream_id AS series_remote_id,
                 COALESCE(NULLIF(uc.custom_name, ''), pc.name) AS series_name
          FROM authorized_user_channels uc
          JOIN provider_channels pc ON pc.id = uc.provider_channel_id
          JOIN providers p ON p.id = pc.provider_id
          JOIN user_categories cat ON cat.id = uc.user_category_id
          WHERE (uc.id = ? OR p.id = ?) AND cat.user_id = ? AND pc.stream_type = 'series'
        `);
    }

    const matches = [];
    for (const assignment of stmts.getLegacySeriesAssignments.all(
      decoded.assignmentId,
      decoded.assignmentId,
      userId
    )) {
        const episode = stmts.getSeriesEpisode.get(
          providerSourceKey(assignment.url),
          assignment.series_remote_id,
          decoded.remoteEpisodeId
        );
        if (episode) matches.push({ ...assignment, ...episode, remote_episode_id: decoded.remoteEpisodeId });
    }
    return matches.length === 1 ? matches[0] : null;
}

export function getProviderPool(userId, providerUrl) {
    const base = providerUrl.replace(/\/+$/, '');
    // ⚡ Bolt: Cache prepared statement to eliminate SQLite compilation overhead on hot paths
    if (!stmts.getProviderPool) {
        stmts.getProviderPool = db.prepare('SELECT * FROM providers WHERE user_id = ? AND url LIKE ?');
    }
    // Fetch all providers for the same user with the same base url
    const providers = stmts.getProviderPool.all(userId, `${base}%`);
    // Filter strictly by normalized base URL in case of LIKE edge cases
    const sourceKey = providerSourceKey(providerUrl);
    return providers.filter(p => providerSourceKey(p.url) === sourceKey);
}

export function parseProviderBackupUrls(value) {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(url => typeof url === 'string' && url.trim()) : [];
    } catch {
        return [];
    }
}

export function getProviderCandidates(userId, originalProvider) {
    const normalizedOriginal = originalProvider.id ? originalProvider : {
        id: originalProvider.provider_id,
        url: originalProvider.provider_url,
        username: originalProvider.provider_user,
        password: originalProvider.provider_pass,
        backup_urls: originalProvider.backup_urls,
        user_agent: originalProvider.user_agent,
        max_connections: originalProvider.provider_max_connections,
        timeshift_timezone: originalProvider.timeshift_timezone
    };
    const categoryOwnerId = Number(originalProvider.category_owner_id);
    const providerOwnerId = Number(originalProvider.provider_owner_id);
    const explicitCrossOwner = Number(originalProvider.granted_by_admin) === 1 &&
        Number.isSafeInteger(categoryOwnerId) && Number.isSafeInteger(providerOwnerId) &&
        providerOwnerId !== categoryOwnerId;

    if (explicitCrossOwner) {
        const candidates = [normalizedOriginal];
        for (const backupUrl of parseProviderBackupUrls(normalizedOriginal.backup_urls)) {
            for (const provider of getProviderPool(userId, backupUrl)) {
                if (!candidates.some(candidate => candidate.id === provider.id)) candidates.push(provider);
            }
        }
        return candidates;
    }

    const pool = getProviderPool(userId, normalizedOriginal.url);

    if (!pool.some(provider => provider.id === normalizedOriginal.id)) {
        pool.push(normalizedOriginal);
    }
    return pool;
}

export async function findAvailableProvider(userId, originalProvider, reqIp, sessionName) {
    const pool = getProviderCandidates(userId, originalProvider);

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

export function shareGuestAllowed(user, channel) {
  if (!user.is_share_guest) return true;
  if (!user.allowed_channels.includes(channel.user_channel_id)) return false;

  const nowSec = Date.now() / 1000;
  return !((user.share_start && nowSec < user.share_start) || (user.share_end && nowSec > user.share_end));
}

export async function ensureUserConnectionAvailable(user, reqIp, sessionName, providerId) {
  if (!(user.max_connections > 0)) return true;

  const isSessionActiveForUser = await streamManager.isSessionActive(user.id, reqIp, sessionName, providerId);
  if (isSessionActiveForUser) return true;

  const active = await streamManager.getUserConnectionCount(user.id);
  return active < user.max_connections;
}

export async function reserveGrantedResourceSession(connectionId, user, channelId, providerId, req, res, sessionName) {
  const channel = getChannel(channelId, user.id);
  const provider = channel && getProviderCandidates(user.id, channel).find(candidate => Number(candidate.id) === Number(providerId));
  if (!provider || !shareGuestAllowed(user, channel)) {
    res.status(403).send('Resource provider is no longer authorized');
    return false;
  }
  if (!await ensureUserConnectionAvailable(user, req.ip, sessionName, provider.id)) {
    res.status(403).send('Max connections reached');
    return false;
  }
  // A grant already contains this account's upstream URL and headers. Switching
  // accounts here would charge a different provider than the one being used.
  if (!await streamManager.isSessionActive(user.id, req.ip, sessionName, provider.id) && provider.max_connections > 0 &&
      await streamManager.getProviderConnectionCount(provider.id) >= provider.max_connections) {
    res.status(403).send('Provider max connections reached');
    return false;
  }
  if (res.destroyed) return false;
  await streamManager.add(connectionId, user, sessionName, req.ip, res, provider.id, { dedupe: false });
  return true;
}

export function applyProviderToChannel(channel, provider) {
  channel.provider_id = provider.id;
  channel.provider_url = provider.url;
  channel.provider_user = provider.username;
  channel.provider_pass = provider.password;
  channel.backup_urls = provider.backup_urls;
  channel.user_agent = provider.user_agent;
  channel.provider_max_connections = provider.max_connections;
  channel.timeshift_timezone = provider.timeshift_timezone || null;
}

async function findActiveProvider(user, provider, req, sessionName) {
  for (const candidate of getProviderCandidates(user.id, provider)) {
    if (await streamManager.isSessionActive(user.id, req.ip, sessionName, candidate.id)) return candidate;
  }
  return null;
}

export async function sendPlaybackDocument(res, upstream) {
  const type = upstream.headers.get('content-type') || '';
  const ttml = /^application\/ttml\+xml(?:\s*;|$)/i.test(type);
  if (!ttml && !/(?:html|xml|text\/css|(?:java|ecma)script|json)/i.test(type)) return false;
  try {
    if (!ttml) {
      discardBody(upstream);
      res.sendStatus(502);
      return true;
    }
    const text = await readBodyWithLimit(upstream, { maxBytes: 4 * 1024 * 1024, timeoutMs: 30000 });
    const safe = validateClientTtml(text);
    res.setHeader('Content-Type', 'application/ttml+xml; charset=utf-8');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(safe);
  } catch {
    discardBody(upstream);
    res.sendStatus(502);
  }
  return true;
}

// Inspect the first box header, extending only ambiguous TS prefixes to three
// packet headers. Restore all bytes so continuous TS keeps its original socket.
async function playbackMediaPrefix(req, res, upstream) {
  const body = upstream.body;
  if (!body?.read || !body.once) return Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    let timer;
    let needed = 8;
    const finish = (error, prefix = Buffer.alloc(0)) => {
      clearTimeout(timer);
      for (const [target, event, listener] of listeners) target?.off?.(event, listener);
      if (error) { discardBody(upstream); reject(error); }
      else resolve(prefix);
    };
    const read = () => {
      try {
        const prefix = body.read(needed);
        if (prefix !== null) {
          body.unshift(prefix);
          if (needed === 8 && prefix.length >= 8 && prefix[0] === 0x47 && isMp4Prefix(prefix)) {
            needed = TRANSPORT_PREFIX_BYTES;
            read();
          } else finish(null, prefix);
        }
        else if (body.readableEnded) finish();
      } catch (error) { finish(error); }
    };
    const aborted = () => finish(new Error('Media client disconnected'));
    const closed = () => finish(new Error('Upstream media closed before classification'));
    const ended = () => finish();
    const listeners = [[body, 'readable', read], [body, 'end', ended], [body, 'error', finish], [body, 'close', closed], [req, 'aborted', aborted], [res, 'close', aborted]];
    for (const [target, event, listener] of listeners) target?.on?.(event, listener);
    timer = setTimeout(() => finish(new Error('Media classification timed out')), 30000);
    timer.unref?.();
    read();
  });
}

export async function preparePlaybackMedia(req, res, user, upstream, { headers, sourceUrl, channelId, providerId, channelName, connectionId, releaseSession }) {
  if (req.aborted || res.destroyed) {
    discardBody(upstream);
    throw new Error('Media client disconnected');
  }
  const type = upstream.headers.get('content-type') || '';
  const mp4 = /^(?:video|audio|application)\/mp4(?:;|$)/i.test(type) ||
    ((!type || /^application\/octet-stream(?:;|$)/i.test(type)) && /\.(?:mp4|m4s|m4a|m4v|cmfv|cmfa)(?:[?#]|$)/i.test(sourceUrl || ''));
  if (!mp4 && upstream.status !== 206) {
    const prefix = await playbackMediaPrefix(req, res, upstream);
    if (isTransportStreamPrefix(prefix) || !isMp4Prefix(prefix)) return upstream;
  }
  const context = withUpstreamCookies(headers, upstream, sourceUrl);
  // Each entry starts its own opaque playback. Subsequent ranges reuse that
  // immutable grant, so rotating response cookies cannot change embedded IDs.
  context.headers = Object.fromEntries(Object.entries(context.headers).filter(([name]) => !/^(?:range|if-range)$/i.test(name)));
  try {
    const location = createClientResourceUrl(req, user, sourceUrl, {
      ...context, kind: 'resource', channelId, providerId, channelName,
    });
    if (!location) throw new Error('Invalid playback resource');
    discardBody(upstream);
    // The provisional registration owns this response. Detach it before
    // removing accounting, which would otherwise destroy the redirect socket.
    streamManager.localStreams.delete(connectionId);
    await releaseSession?.();
    if (req.aborted || res.destroyed) throw new Error('Media client disconnected');
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(307, location);
    return null;
  } finally {
    discardBody(upstream);
  }
}

export async function reserveChannelSession(connectionId, user, channel, req, res, sessionName, options = {}) {
  const activeProvider = options.dedupe === false ? await findActiveProvider(user, channel, req, sessionName) : null;
  if (options.cleanupUser && !activeProvider) {
    await streamManager.cleanupUser(user.id, req.ip);
  }

  if (!await ensureUserConnectionAvailable(user, req.ip, sessionName, activeProvider?.id || channel.provider_id)) {
    res.status(403).send('Max connections reached');
    return false;
  }

  const availableProvider = activeProvider || await findAvailableProvider(user.id, channel, req.ip, sessionName);
  if (!availableProvider) {
    res.status(403).send('Provider max connections reached across all accounts');
    return false;
  }

  applyProviderToChannel(channel, availableProvider);

  if (options.delayMs) {
    await new Promise(resolve => setTimeout(resolve, options.delayMs));
  }

  if (options.dedupe === false) await streamManager.add(connectionId, user, sessionName, req.ip, res, channel.provider_id, { dedupe: false });
  else await streamManager.add(connectionId, user, sessionName, req.ip, res, channel.provider_id);
  return true;
}

export async function reserveProviderSession(connectionId, user, provider, req, res, sessionName, options = {}) {
  const activeProvider = options.dedupe === false ? await findActiveProvider(user, provider, req, sessionName) : null;
  if (!await ensureUserConnectionAvailable(user, req.ip, sessionName, activeProvider?.id || provider.id)) {
    res.status(403).send('Max connections reached');
    return null;
  }

  const availableProvider = activeProvider || await findAvailableProvider(user.id, provider, req.ip, sessionName);
  if (!availableProvider) {
    res.status(403).send('Provider max connections reached across all accounts');
    return null;
  }

  if (options.dedupe === false) await streamManager.add(connectionId, user, sessionName, req.ip, res, availableProvider.id, { dedupe: false });
  else await streamManager.add(connectionId, user, sessionName, req.ip, res, availableProvider.id);
  return availableProvider;
}

export function recordStreamStat(channelId, label) {
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

export function parseMetadata(metadata, label) {
  try {
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch(e) {
    console.warn(`Failed to parse metadata (${label}):`, e.message);
    return {};
  }
}

export function buildStreamHeaders(userAgent, metadata, label) {
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

export function buildBackupUrls(backupUrls, buildUrl, label) {
  if (!backupUrls) return [];

  try {
    const backups = JSON.parse(backupUrls);
    return backups.map(bUrl => buildUrl(bUrl.replace(/\/+$/, '')));
  } catch(e) {
    console.warn(`Failed to parse backup_urls (${label}):`, e.message);
    return [];
  }
}

export function formatTrackLabel(language, codec, fallback) {
  const parts = [language, codec].filter(Boolean);
  return parts.length ? parts.join(' - ') : fallback;
}

export function parseFfmpegTracks(output) {
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

export function probeTracksWithFfmpeg(url, headers) {
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

export function buildFfmpegHeaderArgs(headers) {
  const headerStr = Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
  return headerStr.trim() ? ['-headers', headerStr] : [];
}

export async function sendTrackInfo(res, remoteUrl, backupStreamUrls, headers) {
  const result = await fetchWithBackups(remoteUrl, backupStreamUrls, { headers, redirect: 'follow' });
  try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch {}
  const tracks = await probeTracksWithFfmpeg(result.successfulUrl || remoteUrl, headers);
  res.json(tracks);
}

export async function sendSubtitleTrack(res, remoteUrl, backupStreamUrls, headers, req) {
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

export function selectedTrackIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function hasSelectedVodTracks(req) {
  return selectedTrackIndex(req.query.audio_track) !== null || selectedTrackIndex(req.query.subtitle_track) !== null;
}

export function buildVodOutputOptions(req) {
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

export function createSafeCleanup(connectionId) {
  let cleanedUp = false;
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    return streamManager.remove(connectionId);
  };
}

export function attachResponseCleanup(req, res, cleanup) {
  if (req && typeof req.on === 'function') {
    req.on('close', cleanup);
    req.on('aborted', cleanup);
  }
  if (res && typeof res.on === 'function') {
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  }
  if (req?.aborted || res?.destroyed || res?.writableFinished) cleanup();
}

export function attachStreamHeartbeat(upstreamBody, connectionId) {
  if (!upstreamBody || typeof upstreamBody.on !== 'function') return;

  // streamManager.touch() throttles itself, so every activity signal can be
  // forwarded without a second, differently tuned rate limit here.
  upstreamBody.on('data', () => {
    streamManager.touch(connectionId);
  });
}

// Helper for failover fetching
export async function fetchWithBackups(primaryUrl, backupUrls, options) {
    const urls = [primaryUrl, ...(backupUrls || [])];
    let lastError = null;

    const fetchOptions = { ...options };
    delete fetchOptions.agent;
    delete fetchOptions.redirect;
    // fetchSafe bounds only the wait for the headers. A body this returns is
    // either piped to a player (must not be bounded) or read as a manifest by
    // the caller, which bounds that read with readBodyWithLimit().

    for (const u of urls) {
        if (!u) continue;
        try {
            const res = await fetchSafe(u, fetchOptions);
            if (res.ok) {
                return { response: res, successfulUrl: res.url || u, selectedUrl: u };
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
