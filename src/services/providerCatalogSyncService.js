import { Xtream } from '@iptv/xtream-api';
import { armStreamDeadline, fetchSafe, readBodyWithLimit, resolveBudget } from '../utils/network.js';
import { parseM3uStream } from '../utils/playlistParser.js';
import { sanitizeErrorMessage } from '../utils/helpers.js';

const CATALOG_TIMEOUT_MS = 60000;
// fetchSafe bounds only the headers, so a catalog that starts and then stalls
// needs its own read budget. Generous: a large VOD list is hundreds of MB.
const CATALOG_BODY_TIMEOUT_MS = resolveBudget(process.env.CATALOG_BODY_TIMEOUT_MS, 300000, 1000);
// Buffering, decoding and parsing a catalog costs several times its wire size
// in heap at once, and several providers can be syncing concurrently, so a
// response that never ends has to be refused on size as well as on time. The
// limit is far above a real catalog: it exists to stop a runaway body, not to
// second-guess a large VOD list.
const CATALOG_BODY_MAX_BYTES = resolveBudget(process.env.CATALOG_BODY_MAX_BYTES, 512 * 1024 * 1024, 1024 * 1024);
const readCatalogJson = response => readBodyWithLimit(response, {
  as: 'json', timeoutMs: CATALOG_BODY_TIMEOUT_MS, maxBytes: CATALOG_BODY_MAX_BYTES,
});

export function createXtreamClient(provider) {
  let baseUrl = (provider.url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'http://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  return new Xtream({ url: baseUrl, username: provider.username, password: provider.password });
}

/**
 * Human readable summary of the sections a catalog fetch could not deliver.
 * Used for sync_logs.error_message, so it must stay short and free of URLs.
 */
export function describeCatalogFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  return failures.map(f => `${f.section}: ${f.message}`).join('; ');
}

/**
 * Fetch a provider catalog.
 *
 * A stream type is reported in `completeStreamTypes` only when both its list and
 * its categories were retrieved. Everything that failed is reported in
 * `failures`; callers must not treat an empty catalog as a successful sync.
 */
export async function fetchProviderCatalog(provider, xtream) {
  const baseUrl = provider.url.replace(/\/+$/, '');
  const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(provider.password)}`;
  const allChannels = [];
  const allCategories = [];
  const completeStreamTypes = new Set();
  const snapshotStates = new Map();
  const failures = [];

  const fail = (section, error) => {
    // The message is persisted in sync_logs and rendered in the admin UI. It can
    // contain upstream-controlled text, and fetchSafe embeds the request URL —
    // which carries the provider credentials — in some of its errors.
    const message = sanitizeErrorMessage(error);
    failures.push({ section, message });
    console.error(`${section} fetch failed for provider ${provider.id}:`, message);
  };

  const markComplete = (streamType, count) => {
    completeStreamTypes.add(streamType);
    snapshotStates.set(streamType, { count });
  };

  async function fetchCategories(section, action, categoryType) {
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=${action}`, { timeout: CATALOG_TIMEOUT_MS });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cats = await readCatalogJson(resp);
    if (!Array.isArray(cats)) throw new Error('unexpected category payload');
    cats.forEach(c => { c.category_type = categoryType; allCategories.push(c); });
    return true;
  }

  // 1. Live & M3U Fallback
  let m3uMode = false;
  let liveChans = [];
  let liveFetchComplete = false;
  try {
    // Try Xtream API
    let apiError = null;
    try {
      liveChans = await xtream.getChannels();
      liveFetchComplete = Array.isArray(liveChans);
    } catch (e) {
      apiError = e;
      try {
        const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_live_streams`, { timeout: CATALOG_TIMEOUT_MS });
        if (resp.ok) {
          const contentType = resp.headers?.get?.('content-type');
          if (contentType && contentType.includes('application/json')) {
            liveChans = await readCatalogJson(resp);
            liveFetchComplete = Array.isArray(liveChans);
          } else {
            apiError = new Error(`unexpected content-type ${contentType || 'none'}`);
          }
        } else {
          apiError = new Error(`HTTP ${resp.status}`);
        }
      } catch (e2) { apiError = e2; }
    }

    // M3U Fallback if Xtream failed or empty
    if (!Array.isArray(liveChans) || liveChans.length === 0) {
      const apiFetchComplete = liveFetchComplete;
      liveFetchComplete = false;
      try {
        // Try fetching as M3U
        const m3uResp = await fetchSafe(provider.url, { timeout: CATALOG_TIMEOUT_MS }); // Use original URL
        if (m3uResp.ok) {
          // The playlist is parsed from the stream rather than buffered, so it
          // needs its own deadline. Without one a panel that answers and then
          // stalls wedges performSync forever — and performSync holds the
          // provider lock, whose lease keeps renewing, so every later sync of
          // that provider is skipped until the process restarts.
          const disarm = armStreamDeadline(
            m3uResp.body,
            CATALOG_BODY_TIMEOUT_MS,
            `M3U download exceeded ${CATALOG_BODY_TIMEOUT_MS}ms`
          );
          let parsed;
          try {
            parsed = await parseM3uStream(m3uResp.body);
          } finally {
            disarm();
          }
          if (parsed.isM3u) {
            console.debug('  📂 Detected M3U Playlist');
            m3uMode = true;
            liveFetchComplete = true;

            // Map to Xtream format
            parsed.channels.forEach((ch, idx) => {
              // Generate a stable integer ID from URL
              let hash = 0;
              for (let i = 0; i < ch.url.length; i++) {
                hash = ((hash << 5) - hash) + ch.url.charCodeAt(i);
                hash |= 0;
              }
              const streamId = Math.abs(hash);

              liveChans.push({
                num: idx + 1,
                name: ch.name,
                stream_type: ch.stream_type || 'live',
                stream_id: streamId,
                stream_icon: ch.logo,
                epg_channel_id: ch.epg_id,
                category_id: ch.category_id,
                category_type: ch.stream_type || 'live',
                metadata: ch.metadata || {}, // Store parsed headers/drm (Optimization: avoid double stringify)
                container_extension: ch.url.includes('.mpd') ? 'mpd' : 'ts',
                original_url: ch.url // Pass original URL for proxying later?
              });
            });

            parsed.categories.forEach(cat => {
              allCategories.push({
                category_id: cat.category_id,
                category_name: cat.category_name,
                category_type: cat.category_type
              });
            });
          }
        }
      } catch (e) { console.error('M3U fallback error:', sanitizeErrorMessage(e)); }
      if (!liveFetchComplete && apiFetchComplete) liveFetchComplete = true;
    }

    // Normalize
    if (Array.isArray(liveChans)) {
      liveChans.forEach(c => {
        if (!m3uMode) {
          c.stream_type = 'live';
          c.category_type = 'live';
        }
        allChannels.push(c);
      });
    }

    if (!liveFetchComplete) {
      fail('live', apiError || new Error('live stream list unavailable'));
    } else if (m3uMode) {
      // An M3U playlist carries its categories inline; there is no second call.
      markComplete('live', liveChans.length);
    } else {
      // Only a list *and* its categories make the type safe to clean up.
      try {
        await fetchCategories('live_categories', 'get_live_categories', 'live');
        markComplete('live', liveChans.length);
      } catch (e) { fail('live_categories', e); }
    }
  } catch (e) { fail('live', e); }

  // 2. Movies (VOD)
  // An M3U playlist has no player_api endpoint. Calling it anyway produced two
  // guaranteed failures per run, which now turn an otherwise perfect sync into
  // a permanent 'partial' with an error message in the admin UI.
  if (m3uMode) {
    return { allChannels, allCategories, completeStreamTypes, snapshotStates, failures };
  }

  try {
    console.debug('Fetching VOD streams...');
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_vod_streams`, { timeout: CATALOG_TIMEOUT_MS });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const vods = await readCatalogJson(resp);
    console.debug(`Fetched ${Array.isArray(vods) ? vods.length : 'invalid'} VODs`);
    if (!Array.isArray(vods)) throw new Error('unexpected VOD payload');
    vods.forEach(c => {
      c.stream_type = 'movie';
      c.category_type = 'movie';
      allChannels.push(c);
    });
    try {
      await fetchCategories('vod_categories', 'get_vod_categories', 'movie');
      markComplete('movie', vods.length);
    } catch (e) { fail('vod_categories', e); }
  } catch (e) { fail('vod', e); }

  // 3. Series
  try {
    const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series`, { timeout: CATALOG_TIMEOUT_MS });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const series = await readCatalogJson(resp);
    if (!Array.isArray(series)) throw new Error('unexpected series payload');
    series.forEach(c => {
      c.stream_type = 'series';
      c.category_type = 'series';
      // Map series fields to common format
      c.stream_id = c.series_id;
      c.stream_icon = c.cover;
      allChannels.push(c);
    });
    try {
      await fetchCategories('series_categories', 'get_series_categories', 'series');
      markComplete('series', series.length);
    } catch (e) { fail('series_categories', e); }
  } catch (e) { fail('series', e); }

  return { allChannels, allCategories, completeStreamTypes, snapshotStates, failures };
}
