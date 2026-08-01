import fetch from 'node-fetch';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import ffmpeg from 'fluent-ffmpeg';
import streamManager from '../services/streamManager.js';
import { getXtreamUser } from '../services/authService.js';
import { getBaseUrl, isSafeUrl, safeLookup, redactUrl } from '../utils/helpers.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { fetchSafe } from '../utils/network.js';
import { episodeNameCache } from '../services/episodeCache.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';
import { formatXtreamTimeshiftStart, getEffectiveTimeshiftTimezone, isSupportedEpoch } from '../utils/timezone.js';

import {
  attachResponseCleanup,
  attachStreamHeartbeat,
  buildBackupUrls,
  buildStreamHeaders,
  buildVodOutputOptions,
  createSafeCleanup,
  fetchWithBackups,
  getChannel,
  getSeriesEpisode,
  hasSelectedVodTracks,
  recordStreamStat,
  reserveChannelSession,
  reserveProviderSession,
  sendSubtitleTrack,
  sendTrackInfo,
  shareGuestAllowed
} from './streamControllerHelpers.js';
export * from './streamControllerHelpers.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

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
            } catch {
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
    if (req.path.endsWith('.mp3')) reqExt = 'mp3';
    if (req.path.endsWith('.aac')) reqExt = 'aac';

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

    const remoteExt = (!wantsTranscode && ['m3u8', 'mp3', 'aac'].includes(reqExt)) ? reqExt : 'ts';

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
        const isMp3 = (reqExt === 'mp3');
        const outputFormat = isMp4 ? 'mp4' : (isMp3 ? 'mp3' : 'mpegts');
        const contentType = isMp4 ? 'video/mp4' : (isMp3 ? 'audio/mpeg' : 'video/mp2t');

        res.setHeader('Content-Type', contentType);
        res.setHeader('Connection', 'keep-alive');

        const outputOptions = isMp3
          ? ['-vn', '-c:a libmp3lame', '-b:a 128k', '-f mp3']
          : ['-c:v copy', '-c:a aac', '-b:a 128k', `-f ${outputFormat}`];

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
            try { command.kill('SIGKILL'); } catch {}
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch {}
            try { if (!res.destroyed) res.destroy(); } catch {}
          }
        });

        attachResponseCleanup(req, res, () => {
          try { command.kill('SIGKILL'); } catch {}
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
        } catch {
          return match;
        }
      }).replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1, baseUrl).toString();
          // Only encrypt the changing URL part
          const payload = { u: absoluteUrl, c: channel.name, p: channel.provider_id };
          const encrypted = encrypt(JSON.stringify(payload));
          return `URI="/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.key?data=${encodeURIComponent(encrypted)}&base=${baseEncoded}${tokenParam}"`;
        } catch {
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

    res.setHeader(
      'Content-Type',
      reqExt === 'mp3' ? 'audio/mpeg' : (reqExt === 'aac' ? 'audio/aac' : 'video/mp2t')
    );
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
        try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch {}
        try { if (!res.destroyed) res.destroy(); } catch {}
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
        } catch {}
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
        } catch {
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
    if (!streamId) return res.sendStatus(404);

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);
    const ext = normalizeContainerExtension(channel.mime_type, 'mp4');

    const sessionName = `${channel.name} (VOD)`;

    const sourcePassword = decrypt(channel.provider_pass);
    let base = channel.provider_url.replace(/\/+$/, '');
    let remoteUrl = `${base}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(sourcePassword)}/${channel.remote_stream_id}.${ext}`;

    let backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(sourcePassword)}/${channel.remote_stream_id}.${ext}`;
    }, 'Movie');

    let { headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'Movie');

    if (req.query.subtitle_format === 'vtt') {
      await sendSubtitleTrack(res, remoteUrl, backupStreamUrls, headers, req);
      return;
    }

    if (req.query.tracks === 'true') {
      await sendTrackInfo(res, remoteUrl, backupStreamUrls, headers);
      return;
    }

    if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

    channel.provider_pass = decrypt(channel.provider_pass);
    base = channel.provider_url.replace(/\/+$/, '');
    remoteUrl = `${base}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;
    backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/movie/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.${ext}`;
    }, 'Movie');
    ({ headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'Movie'));

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
            try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch {}

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
                try { command.kill('SIGKILL'); } catch {}
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
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch {}
            try { if (!res.destroyed) res.destroy(); } catch {}
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

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const seriesEpisode = getSeriesEpisode(epIdRaw, user.id);
    if (!seriesEpisode) return res.sendStatus(404);
    if (!shareGuestAllowed(user, seriesEpisode)) return res.sendStatus(403);

    const provider = seriesEpisode;
    const remoteEpisodeId = seriesEpisode.remote_episode_id;
    const ext = normalizeContainerExtension(seriesEpisode.container_extension);

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
            try { if (result.response && result.response.body && !result.response.body.destroyed) result.response.body.destroy(); } catch {}

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
                try { command.kill('SIGKILL'); } catch {}
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
            try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch {}
            try { if (!res.destroyed) res.destroy(); } catch {}
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
    const duration = String(req.params.duration || '');
    const start = String(req.params.start || '');
    const durationNumber = Number(duration);
    const epochStart = start.startsWith('epoch-') ? Number(start.slice(6)) : null;

    if (!streamId) return res.sendStatus(404);
    if (!Number.isSafeInteger(durationNumber) || durationNumber <= 0 || durationNumber > 1440) return res.sendStatus(400);
    if (start.startsWith('epoch-')) {
      if (!isSupportedEpoch(epochStart)) return res.sendStatus(400);
    } else if (!/^\d{4}-\d{2}-\d{2}:\d{2}-\d{2}$/.test(start)) {
      return res.sendStatus(400);
    }

    const user = await getXtreamUser(req);
    if (!user) return res.sendStatus(401);

    const channel = getChannel(streamId, user.id);

    if (!channel) return res.sendStatus(404);

    if (!shareGuestAllowed(user, channel)) return res.sendStatus(403);

    if (epochStart !== null) {
      const now = Math.floor(Date.now() / 1000);
      const archiveDays = Math.min(Math.max(Number(channel.tv_archive_duration) || 0, 0), 14);
      let archiveProgram;
      try {
        const { getEpgProgramsForChannels } = await import('../services/epgService.js');
        const programs = channel.tv_archive && channel.epg_channel_id
          ? getEpgProgramsForChannels(new Set([channel.epg_channel_id]), epochStart - 1, epochStart + durationNumber * 60 + 1, 10).get(channel.epg_channel_id) || []
          : [];
        archiveProgram = programs.find(program => Number(program.start) === epochStart);
      } catch {
        archiveProgram = null;
      }
      const archiveStart = Number(archiveProgram?.start);
      const archiveStop = Number(archiveProgram?.stop);
      const expectedDuration = isSupportedEpoch(archiveStart) && isSupportedEpoch(archiveStop) && archiveStop > archiveStart
        ? Math.min(Math.max(Math.ceil((archiveStop - archiveStart) / 60), 1), 1440)
        : 0;
      if (
        !channel.tv_archive ||
        !archiveProgram ||
        !isSupportedEpoch(archiveStart) ||
        !isSupportedEpoch(archiveStop) ||
        archiveStart !== epochStart ||
        archiveStop <= archiveStart ||
        archiveStop > now ||
        epochStart > now ||
        epochStart < now - archiveDays * 86400 ||
        expectedDuration !== durationNumber
      ) {
        return res.sendStatus(404);
      }
    }

    const sessionName = `${channel.name} (Timeshift)`;

    if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName)) return;

    channel.provider_pass = decrypt(channel.provider_pass);

    const base = channel.provider_url.replace(/\/+$/, '');
    const reqExt = req.path.endsWith('.m3u8') ? 'm3u8' : 'ts';
    const upstreamStart = epochStart === null
      ? start
      : formatXtreamTimeshiftStart(epochStart, getEffectiveTimeshiftTimezone(channel.timeshift_timezone));
    if (!upstreamStart) {
      streamManager.remove(connectionId);
      return res.sendStatus(400);
    }
    const remoteUrl = `${base}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${durationNumber}/${upstreamStart}/${channel.remote_stream_id}.${reqExt}`;

    const backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
        return `${bBase}/timeshift/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${durationNumber}/${upstreamStart}/${channel.remote_stream_id}.${reqExt}`;
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
        } catch {
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
        try { if (upstream.body && !upstream.body.destroyed) upstream.body.destroy(); } catch {}
        try { if (!res.destroyed) res.destroy(); } catch {}
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
