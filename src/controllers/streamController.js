import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import streamManager from '../services/streamManager.js';
import { getXtreamUser } from '../services/authService.js';
import { redactUrl } from '../utils/helpers.js';
import { readBodyWithLimit } from '../utils/network.js';
import { resolveBudget } from '../utils/env.js';
import { decrypt } from '../utils/crypto.js';
import { createUpstreamContext, withUpstreamCookies } from '../utils/clientCookies.js';
import { createClientResourceUrl } from '../services/clientResourceService.js';
import { rewriteHlsManifest, rewriteDashManifest, isClientManifest } from '../utils/clientManifests.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';

import { formatXtreamTimeshiftStart, getEffectiveTimeshiftTimezone, isSupportedEpoch } from '../utils/timezone.js';

import {
  attachResponseCleanup,
  attachStreamHeartbeat,
  buildBackupUrls,
  buildStreamHeaders,
  createSafeCleanup,
  fetchWithBackups,
  getChannel,
  preparePlaybackMedia,
  recordStreamStat,
  reserveChannelSession,
  sendPlaybackDocument,
  shareGuestAllowed
} from './streamControllerHelpers.js';
import { proxyMovie, proxySeries } from './streamMediaController.js';

// A manifest is a finite document. fetchSafe bounds only the wait for the
// headers, so an upstream that answers and then stalls would otherwise hold the
// request and its stream session open indefinitely.
const MANIFEST_BODY_TIMEOUT_MS = resolveBudget(
  process.env.MANIFEST_BODY_TIMEOUT_MS, 30000, 1000, Number.MAX_SAFE_INTEGER, 'MANIFEST_BODY_TIMEOUT_MS');
const MANIFEST_MAX_BYTES = resolveBudget(
  process.env.MANIFEST_MAX_BYTES, 32 * 1024 * 1024, 64 * 1024, Number.MAX_SAFE_INTEGER, 'MANIFEST_MAX_BYTES');
const readManifest = response => readBodyWithLimit(response, {
  timeoutMs: MANIFEST_BODY_TIMEOUT_MS,
  maxBytes: MANIFEST_MAX_BYTES,
});

export { proxyMovie, proxySeries };
export * from './streamControllerHelpers.js';

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
        if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName, { dedupe: false })) return;

        ({ headers } = buildStreamHeaders(channel.user_agent, channel.metadata, 'MPD'));
        channel.provider_pass = decrypt(channel.provider_pass);
        const base = channel.provider_url.replace(/\/+$/, '');
        upstreamUrl = `${base}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;

        backupStreamUrls = buildBackupUrls(channel.backup_urls, (bBase) => {
            return `${bBase}/live/${encodeURIComponent(channel.provider_user)}/${encodeURIComponent(channel.provider_pass)}/${channel.remote_stream_id}.mpd`;
        }, 'MPD');
    }

    if (usesOriginalUrl && !await reserveChannelSession(connectionId, user, channel, req, res, sessionName, { dedupe: false })) return;

    recordStreamStat(channel.provider_channel_id, 'MPD');

    let upstream, selectedUrl;
    try {
        const result = await fetchWithBackups(upstreamUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        upstream = result.response;
        selectedUrl = result.selectedUrl;
    } catch (e) {
        console.error(`MPD proxy failed: ${e.message}`);
        streamManager.localStreams.delete(connectionId);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
    }

    const manifestKind = isClientManifest(upstream.headers.get('content-type'), upstream.url || upstreamUrl) || ((!relativePath || relativePath.endsWith('.mpd')) ? 'dash' : null);
    if (manifestKind) {
        const text = await readManifest(upstream);
        const nextContext = withUpstreamCookies(headers, upstream, selectedUrl || upstreamUrl);
        const rewrite = manifestKind === 'hls' ? rewriteHlsManifest : rewriteDashManifest;
        const newText = rewrite(text, upstream.url || upstreamUrl, (url, options) => createClientResourceUrl(req, user, url, {
          kind: 'resource', ...nextContext, channelName: sessionName, providerId: channel.provider_id, channelId: channel.user_channel_id || channel.id, ...options
        }));
        res.setHeader('Content-Type', manifestKind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
        res.send(newText);
        streamManager.remove(connectionId);
        return;
    }

    if (await sendPlaybackDocument(res, upstream)) {
      streamManager.remove(connectionId);
      return;
    }
    upstream = await preparePlaybackMedia(req, res, user, upstream, { headers, sourceUrl: selectedUrl || upstreamUrl, channelId: channel.user_channel_id || channel.id, providerId: channel.provider_id });
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    upstream.body.pipe(res);
    upstream.body.once('error', () => {
       streamManager.remove(connectionId);
       if (!res.headersSent) res.sendStatus(502);
       else res.destroy();
    });
    attachResponseCleanup(req, res, () => {
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
          dedupe: wantsTranscode || reqExt === 'mp4',
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

    let upstream, successfulUrl, selectedUrl;
    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers: fetchHeaders,
            redirect: 'follow'
        });
        upstream = result.response;
        successfulUrl = result.successfulUrl;
        selectedUrl = result.selectedUrl;
    } catch(e) {
        console.error(`Stream proxy error: ${e.message} for ${redactUrl(remoteUrl)}`);
        streamManager.localStreams.delete(connectionId);
        cleanup();
        return res.sendStatus(502);
    }

    const manifestKind = isClientManifest(upstream.headers.get('content-type'), upstream.url || successfulUrl) || (reqExt === 'm3u8' ? 'hls' : null);
    if (manifestKind) {
      const text = await readManifest(upstream);
      const baseUrl = upstream.url || successfulUrl;
      const nextContext = withUpstreamCookies(fetchHeaders, upstream, selectedUrl || remoteUrl);

      const rewrite = manifestKind === 'hls' ? rewriteHlsManifest : rewriteDashManifest;
      const newText = rewrite(text, baseUrl, (absoluteUrl, options) => createClientResourceUrl(req, user, absoluteUrl, {
        kind: 'resource', ...nextContext, channelName: channel.name, providerId: channel.provider_id,
        channelId: channel.user_channel_id || channel.id, ...options,
      }));

      res.setHeader('Content-Type', manifestKind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(newText);

      cleanup();
      return;
    }

    if (await sendPlaybackDocument(res, upstream)) { cleanup(); return; }
    upstream = await preparePlaybackMedia(req, res, user, upstream, { headers: fetchHeaders, sourceUrl: selectedUrl || remoteUrl, channelId: channel.user_channel_id || channel.id, providerId: channel.provider_id });
    await streamManager.cleanupSession(user.id, req.ip, channel.name, channel.provider_id, connectionId);
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
    if (!res.headersSent && !res.destroyed) {
        streamManager.localStreams.delete(connectionId);
        cleanup();
        return res.sendStatus(500);
    }
    cleanup();
  }
};

// --- Segment Proxy ---
export const proxySegment = async (req, res) => {
  try {
    const user = await getXtreamUser(req, { fresh: true });
    if (!user) return res.sendStatus(401);

    let headers = { 'User-Agent': DEFAULT_USER_AGENT, Connection: 'keep-alive' };
    let cookieJar = null;
    let headerOrigin = null;
    if (req.query.base) {
      const rawBase = decrypt(req.query.base);
      if (!rawBase) return res.sendStatus(400);
      const base = JSON.parse(rawBase);
      headers = { ...headers, ...base.h };
      cookieJar = base.j || null;
      headerOrigin = base.o || null;
    }
    const raw = req.query.data && decrypt(req.query.data);
    if (!raw) return res.sendStatus(400);
    const payload = JSON.parse(raw);
    const channelId = Number(payload.i);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) return res.sendStatus(403);
    const channel = getChannel(channelId, user.id);
    if (!channel || !shareGuestAllowed(user, channel)) return res.sendStatus(403);
    const providerId = Number(payload.p) || Number(channel.provider_id);
    if (!Number.isSafeInteger(providerId) || providerId <= 0) return res.sendStatus(403);
    if (typeof payload.u !== 'string' || !/^https?:\/\//i.test(payload.u)) return res.sendStatus(400);
    headers = { ...headers, ...payload.h };
    const context = createUpstreamContext(headers, headerOrigin || payload.u, cookieJar, headerOrigin || payload.u);
    const grant = createClientResourceUrl(req, user, payload.u, {
      kind: 'resource', ...context, channelId, providerId,
      channelName: payload.c || channel.name || 'Channel', hlsVariables: payload.v || {},
    });
    if (!grant) return res.sendStatus(400);
    // Old envelopes share the same capacity checks and content validation as new grants.
    const target = new URL(grant);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.redirect(307, `${target.pathname}${target.search}${target.hash}`);
  } catch {
    if (!res.headersSent) return res.sendStatus(400);
  }
};

// --- Movie Proxy ---
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

    if (!await reserveChannelSession(connectionId, user, channel, req, res, sessionName, { dedupe: false })) return;

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

    let upstream, successfulUrl, selectedUrl;
    try {
        const result = await fetchWithBackups(remoteUrl, backupStreamUrls, {
            headers,
            redirect: 'follow'
        });
        upstream = result.response;
        successfulUrl = result.successfulUrl;
        selectedUrl = result.selectedUrl;
    } catch(e) {
        console.error(`Timeshift proxy error: ${e.message}`);
        streamManager.localStreams.delete(connectionId);
        streamManager.remove(connectionId);
        return res.sendStatus(502);
    }

    const manifestKind = isClientManifest(upstream.headers.get('content-type'), upstream.url || successfulUrl) || (reqExt === 'm3u8' ? 'hls' : null);
    if (manifestKind) {
      const text = await readManifest(upstream);
      const baseUrl = upstream.url || successfulUrl;
      const nextContext = withUpstreamCookies(headers, upstream, selectedUrl || remoteUrl);

      const rewrite = manifestKind === 'hls' ? rewriteHlsManifest : rewriteDashManifest;
      const newText = rewrite(text, baseUrl, (absoluteUrl, options) => createClientResourceUrl(req, user, absoluteUrl, {
        kind: 'resource', ...nextContext, channelName: sessionName, providerId: channel.provider_id,
        channelId: channel.user_channel_id || channel.id, ...options,
      }));

      res.setHeader('Content-Type', manifestKind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(newText);

      streamManager.remove(connectionId);
      return;
    }

    if (await sendPlaybackDocument(res, upstream)) { streamManager.remove(connectionId); return; }
    upstream = await preparePlaybackMedia(req, res, user, upstream, { headers, sourceUrl: selectedUrl || remoteUrl, channelId: channel.user_channel_id || channel.id, providerId: channel.provider_id });
    await streamManager.cleanupSession(user.id, req.ip, sessionName, channel.provider_id, connectionId);
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
