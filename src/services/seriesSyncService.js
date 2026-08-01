import { clearChannelsCache } from './cacheService.js';
import db from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { providerSourceKey } from '../utils/helpers.js';

// --- Series episode sync ----------------------------------------------------
// Xtream get.php playlists list every episode of every series. Episodes are
// not included in get_series, so they are fetched per series via
// get_series_info and cached in provider_series_episodes. The last_modified
// value from get_series (stored in provider_channels.metadata) gates
// refetching, so after the initial run only changed series are re-fetched.
//
// Episode data is stored per upstream panel and series. Playable URLs use a
// persistent compact alias bound to the exact authorized series assignment;
// a raw series assignment ID is never treated as an episode ID. Legacy IDs
// remain usable only when they resolve to one authorized cached episode.

const EPISODE_SYNC_CONCURRENCY = 3;
const EPISODE_SYNC_RETRY_AGE = 7 * 86400; // re-check series lacking last_modified weekly

const episodeSyncLocks = new Set();
const episodeSyncRequests = new Map();

export function parseSeriesInfoEpisodes(data) {
  const episodes = [];
  if (!data || !data.episodes) return episodes;
  const seasons = Array.isArray(data.episodes) ? data.episodes : Object.values(data.episodes);
  for (const seasonEps of seasons) {
    if (!Array.isArray(seasonEps)) continue;
    for (const ep of seasonEps) {
      const remoteEpisodeId = Number(ep && ep.id);
      if (!remoteEpisodeId) continue;
      episodes.push({
        remote_episode_id: remoteEpisodeId,
        season: Number(ep.season) || 0,
        episode_num: Number(ep.episode_num) || 0,
        title: ep.title ? String(ep.title) : '',
        container_extension: normalizeContainerExtension(ep.container_extension),
        logo: (ep.info && (ep.info.movie_image || ep.info.cover_big)) || '',
        added: ep.added ? String(ep.added) : ''
      });
    }
  }
  return episodes;
}

function createSeriesEpisodeWriter(sourceKey) {
  const upsertEpisode = db.prepare(`
    INSERT INTO provider_series_episodes
      (source_key, series_remote_id, remote_episode_id, season, episode_num, title, container_extension, logo, added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, series_remote_id, remote_episode_id) DO UPDATE SET
      season = excluded.season,
      episode_num = excluded.episode_num,
      title = excluded.title,
      container_extension = excluded.container_extension,
      logo = excluded.logo,
      added = excluded.added
  `);
  const selectExistingEpisodes = db.prepare('SELECT remote_episode_id FROM provider_series_episodes WHERE source_key = ? AND series_remote_id = ?');
  const deleteEpisode = db.prepare('DELETE FROM provider_series_episodes WHERE source_key = ? AND series_remote_id = ? AND remote_episode_id = ?');
  const upsertState = db.prepare(`
    INSERT INTO provider_series_state (source_key, series_remote_id, last_modified, synced_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_key, series_remote_id) DO UPDATE SET
      last_modified = excluded.last_modified,
      synced_at = excluded.synced_at
  `);

  return db.transaction((sid, lastModified, episodes) => {
    const keep = new Set();
    for (const ep of episodes) {
      upsertEpisode.run(sourceKey, sid, ep.remote_episode_id, ep.season, ep.episode_num, ep.title, ep.container_extension, ep.logo, ep.added);
      keep.add(ep.remote_episode_id);
    }
    for (const row of selectExistingEpisodes.all(sourceKey, sid)) {
      if (!keep.has(Number(row.remote_episode_id))) deleteEpisode.run(sourceKey, sid, row.remote_episode_id);
    }
    upsertState.run(sourceKey, sid, lastModified, Math.floor(Date.now() / 1000));
  });
}

async function fetchSeriesEpisodes(baseUrl, authParams, sid, lastModified, applySeries) {
  const resp = await fetchSafe(`${baseUrl}/player_api.php?${authParams}&action=get_series_info&series_id=${sid}`, { timeout: 30000 });
  if (!resp.ok) return null;
  const data = await resp.json();
  // Error payloads (auth failures etc.) carry neither episodes nor info;
  // skip instead of wiping previously synced episodes.
  if (!data || typeof data !== 'object' || (!data.episodes && !data.info)) return null;
  const episodes = parseSeriesInfoEpisodes(data);
  applySeries(sid, lastModified, episodes);
  return episodes.length;
}

function fetchSeriesEpisodesOnce(sourceKey, sid, fetcher) {
  const requestKey = `${sourceKey}:${sid}`;
  if (episodeSyncRequests.has(requestKey)) return episodeSyncRequests.get(requestKey);
  const request = Promise.resolve().then(fetcher)
    .finally(() => episodeSyncRequests.delete(requestKey));
  episodeSyncRequests.set(requestKey, request);
  return request;
}

export async function syncSeriesEpisode(providerId, seriesRemoteId) {
  const sid = Number(seriesRemoteId);
  if (!Number.isSafeInteger(sid) || sid <= 0) return { error: 'Invalid series ID' };

  const series = db.prepare(`
    SELECT p.*, pc.metadata
    FROM providers p
    JOIN provider_channels pc ON pc.provider_id = p.id
    WHERE p.id = ? AND pc.remote_stream_id = ? AND pc.stream_type = 'series'
  `).get(providerId, sid);
  if (!series) return { error: 'Series not found' };

  let lastModified = '';
  try {
    const metadata = JSON.parse(series.metadata || '{}');
    if (metadata.original_url) return { skipped: true };
    if (metadata.last_modified !== undefined && metadata.last_modified !== null) {
      lastModified = String(metadata.last_modified);
    }
  } catch { /* ignore malformed metadata */ }

  const sourceKey = providerSourceKey(series.url);
  if (!sourceKey) return { error: 'Provider has no URL' };
  const password = decrypt(series.password);
  const baseUrl = series.url.replace(/\/+$/, '');
  const authParams = `username=${encodeURIComponent(series.username)}&password=${encodeURIComponent(password)}`;
  const episodeCount = await fetchSeriesEpisodesOnce(sourceKey, sid, () =>
    fetchSeriesEpisodes(
      baseUrl,
      authParams,
      sid,
      lastModified,
      createSeriesEpisodeWriter(sourceKey)
    )
  );
  if (episodeCount === null) return { synced: 0, failed: 1 };
  if (episodeCount > 0) clearChannelsCache();
  return { synced: 1, failed: 0, episodes: episodeCount };
}

export async function syncSeriesEpisodes(providerId) {
  const provider = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!provider) return { error: 'Provider not found' };

  const sourceKey = providerSourceKey(provider.url);
  if (!sourceKey) return { error: 'Provider has no URL' };

  if (episodeSyncLocks.has(sourceKey)) {
    console.debug(`Episode sync already running for source ${sourceKey}, skipping`);
    return { skipped: true };
  }
  episodeSyncLocks.add(sourceKey);

  try {
    const password = decrypt(provider.password);
    const baseUrl = provider.url.replace(/\/+$/, '');
    const authParams = `username=${encodeURIComponent(provider.username)}&password=${encodeURIComponent(password)}`;

    // All provider rows pointing at the same upstream panel share the catalog
    const siblingProviderIds = db.prepare('SELECT id, url FROM providers').all()
      .filter(p => providerSourceKey(p.url) === sourceKey)
      .map(p => p.id);

    // Drop episodes/state of series that no longer exist at the upstream
    // (i.e. in no provider row of this source)
    const siblingPlaceholders = siblingProviderIds.map(() => '?').join(',');
    db.prepare(`
      DELETE FROM provider_series_episodes WHERE source_key = ? AND series_remote_id NOT IN (
        SELECT remote_stream_id FROM provider_channels WHERE provider_id IN (${siblingPlaceholders}) AND stream_type = 'series')
    `).run(sourceKey, ...siblingProviderIds);
    db.prepare(`
      DELETE FROM provider_series_state WHERE source_key = ? AND series_remote_id NOT IN (
        SELECT remote_stream_id FROM provider_channels WHERE provider_id IN (${siblingPlaceholders}) AND stream_type = 'series')
    `).run(sourceKey, ...siblingProviderIds);

    const seriesRows = db.prepare(`
      SELECT remote_stream_id, metadata FROM provider_channels
      WHERE provider_id = ? AND stream_type = 'series'
    `).all(providerId);
    if (seriesRows.length === 0) return { synced: 0, failed: 0, total: 0 };

    const stateRows = db.prepare('SELECT series_remote_id, last_modified, synced_at FROM provider_series_state WHERE source_key = ?').all(sourceKey);
    const stateMap = new Map(stateRows.map(s => [Number(s.series_remote_id), s]));

    const nowSec = Math.floor(Date.now() / 1000);
    const queue = [];
    for (const row of seriesRows) {
      const sid = Number(row.remote_stream_id);
      if (!sid) continue;
      let lastModified = '';
      let fromM3u = false;
      try {
        const meta = JSON.parse(row.metadata || '{}');
        if (meta.last_modified !== undefined && meta.last_modified !== null) lastModified = String(meta.last_modified);
        // Entries parsed from an M3U playlist have no Xtream API behind them;
        // get_series_info would fail on every sync, so never queue them.
        if (meta.original_url) fromM3u = true;
      } catch { /* ignore malformed metadata */ }
      if (fromM3u) continue;

      const state = stateMap.get(sid);
      if (!state) {
        queue.push({ sid, lastModified });
      } else if (lastModified) {
        if ((state.last_modified || '') !== lastModified) queue.push({ sid, lastModified });
      } else if ((nowSec - (state.synced_at || 0)) >= EPISODE_SYNC_RETRY_AGE) {
        queue.push({ sid, lastModified });
      }
    }

    if (queue.length === 0) {
      console.debug(`Episode sync for provider ${provider.name}: everything up to date`);
      return { synced: 0, failed: 0, total: 0 };
    }
    console.info(`📺 Episode sync for provider ${provider.name}: ${queue.length}/${seriesRows.length} series to update`);

    const applySeries = createSeriesEpisodeWriter(sourceKey);

    let processed = 0;
    let failed = 0;
    let episodeCount = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        try {
          const count = await fetchSeriesEpisodesOnce(sourceKey, item.sid, () =>
            fetchSeriesEpisodes(baseUrl, authParams, item.sid, item.lastModified, applySeries)
          );
          if (count === null) { failed++; continue; }
          episodeCount += count;
          processed++;
          if (processed % 250 === 0) {
            console.info(`📺 Episode sync progress (${sourceKey}): ${processed}/${queue.length} series`);
          }
        } catch (e) {
          failed++;
          console.debug(`Episode fetch failed for series ${item.sid}: ${e.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EPISODE_SYNC_CONCURRENCY, queue.length) }, () => worker()));

    if (processed > 0) clearChannelsCache();
    console.info(`✅ Episode sync completed for provider ${provider.name}: ${processed} series updated (${episodeCount} episodes), ${failed} failed`);
    return { synced: processed, failed, total: queue.length };
  } finally {
    episodeSyncLocks.delete(sourceKey);
  }
}
