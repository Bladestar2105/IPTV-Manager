import crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import streamManager from '../services/streamManager.js';
import { getXtreamUser } from '../services/authService.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { episodeNameCache } from '../services/episodeCache.js';
import { decrypt } from '../utils/crypto.js';
import { DEFAULT_USER_AGENT } from '../config/constants.js';
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

