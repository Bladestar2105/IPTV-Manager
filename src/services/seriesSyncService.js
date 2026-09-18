import { clearChannelsCache } from './cacheService.js';
import { formatDbError, immediateTransaction, isRetryableSqliteError, runWriteWithRetry } from '../database/sqliteWrites.js';
import { acquireSourceLock, describeLock, isCooldownHolder, sourceLockKey } from './providerLockService.js';
import db from '../database/db.js';
import { fetchSafe, readBodyWithLimit } from '../utils/network.js';
import { decrypt } from '../utils/crypto.js';
import { normalizeContainerExtension } from '../utils/containerExtension.js';
import { providerSourceKey, sanitizeErrorMessage } from '../utils/helpers.js';

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
// An upstream that stops answering does not recover within one run. Grinding
// through tens of thousands of series against it costs one timeout each, keeps
// the request slots busy and floods the log; the next scheduled sync retries.
const EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES =
  Math.max(5, Number(process.env.EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES) || 25);
// Giving up says the panel is down, and the panel is shared: every provider row
// pointing at it would otherwise take the freed lock in turn and spend its own
// full budget against the same dead host, multiplying the cost of the breaker
// by the number of siblings. Keep the source locked until it is worth retrying.
// Seconds, in a configuration surface that is otherwise milliseconds, so it is
// capped as well as floored: the lease is written into the lock table with
// nobody renewing it, survives every restart and can only be waited out, so an
// operator who writes 1800000 out of habit would lose episode sync on that panel
// for three weeks.
const EPISODE_SYNC_GIVE_UP_COOLDOWN_SECONDS = Math.min(
  6 * 3600,
  Math.max(60, Number.parseInt(process.env.EPISODE_SYNC_GIVE_UP_COOLDOWN_SECONDS, 10) || 1800)
);
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

  // BEGIN IMMEDIATE: this body upserts, then reads the existing episodes, then
  // deletes. A deferred transaction failed here with "database is locked" while
  // a catalog sync was writing.
  return immediateTransaction(db, (sid, lastModified, episodes) => {
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
  if (!resp.ok) {
    // A panel answering 401/429/5xx fast is exactly the case the breaker is
    // for. Returning null here made it a silent per-series skip, so a refusing
    // panel still received one request for every queued series.
    const error = new Error(`HTTP ${resp.status}`);
    error.upstreamStatus = resp.status;
    throw error;
  }
  // One series document; bounded so a stalled body cannot hold a worker slot.
  const data = await readBodyWithLimit(resp, { as: 'json', timeoutMs: 30000, maxBytes: 32 * 1024 * 1024 });
  // Error payloads (auth failures etc.) carry neither episodes nor info;
  // skip instead of wiping previously synced episodes.
  if (!data || typeof data !== 'object' || (!data.episodes && !data.info)) return null;
  const episodes = parseSeriesInfoEpisodes(data);
  // The write is short and fully repeatable: it rebuilds the episode set for
  // this series from the payload that is already in memory.
  try {
    await runWriteWithRetry(() => applySeries(sid, lastModified, episodes), { label: `series ${sid} episodes` });
  } catch (e) {
    // Tag it at the one place that knows where the failure came from. Deciding
    // by "is this one of the three retryable SQLite codes" made SQLITE_FULL, an
    // I/O error and a driver TypeError all look like an unanswering panel, so a
    // full disk could cool a perfectly healthy upstream down for half an hour.
    if (e && typeof e === 'object') e.localFailure = true;
    throw e;
  }
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
  let episodeCount;
  try {
    episodeCount = await fetchSeriesEpisodesOnce(sourceKey, sid, () =>
      fetchSeriesEpisodes(
        baseUrl,
        authParams,
        sid,
        lastModified,
        createSeriesEpisodeWriter(sourceKey)
      )
    );
  } catch (e) {
    // The on-demand path reports a failed refresh; only the batch run counts
    // failures toward its breaker.
    console.debug(`Episode fetch failed for series ${sid}: ${sanitizeErrorMessage(e)}`);
    return { synced: 0, failed: 1 };
  }
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

  // Provider rows commonly share one upstream panel, and the in-process Set
  // above cannot see a run in another cluster worker. Without a shared lock each
  // provider of the same panel starts its own run with its own request
  // concurrency against that single host.
  const sourceLock = acquireSourceLock(sourceKey, 'episodes');
  if (!sourceLock) {
    const holder = describeLock(sourceLockKey(sourceKey));
    const why = isCooldownHolder(holder)
      ? 'the panel stopped answering and the source is cooling down'
      : `a run is already in progress${holder ? ` in pid ${holder.owner_pid}` : ''}`;
    console.debug(`Episode sync for source ${sourceKey} skipped: ${why}`);
    return { skipped: true };
  }
  episodeSyncLocks.add(sourceKey);

  // Set when the run establishes that the upstream is not answering; see the
  // constant above for why that outcome has to outlive the run.
  let cooldownSeconds = 0;

  try {
    // All provider rows pointing at the same upstream panel share the catalog
    const siblings = db.prepare('SELECT id, url, username, password FROM providers').all()
      .filter(p => providerSourceKey(p.url) === sourceKey);
    const siblingProviderIds = siblings.map(p => p.id);

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

    // Episodes are stored per source, and this run holds the source lock, so it
    // is the only run that will touch this panel. A queue filtered to the
    // triggering provider therefore leaves every series that only a sibling
    // carries unfetched — and because the provider whose catalog sync finishes
    // first wins the lock, that tends to be the same provider every cycle, so
    // those series are never fetched at all. Queue the union of all siblings and
    // fetch each series with the credentials of a provider that actually carries
    // it; a sibling's login is not necessarily entitled to another's packages.
    const credentials = new Map(siblings.map(sib => [sib.id, {
      baseUrl: (sib.url || '').replace(/\/+$/, ''),
      authParams: `username=${encodeURIComponent(sib.username)}&password=${encodeURIComponent(decrypt(sib.password))}`,
    }]));

    const stateRows = db.prepare('SELECT series_remote_id, last_modified, synced_at FROM provider_series_state WHERE source_key = ?').all(sourceKey);
    const stateMap = new Map(stateRows.map(s => [Number(s.series_remote_id), s]));

    const nowSec = Math.floor(Date.now() / 1000);
    const queue = [];
    const seen = new Set();
    let totalSeries = 0;

    // The triggering provider decides first, so a series it carries is fetched
    // with its own credentials. Two passes rather than one query ordered by
    // `CASE WHEN provider_id = ?`: that ordering made SQLite sort the whole
    // union in a temp B-tree before yielding a row — on the deployment this was
    // written for, 403,763 rows carrying 87.6 MiB of metadata — which also
    // defeated the point of iterating instead of materializing. Two plain index
    // scans need no sort at all.
    const passes = [[providerId]];
    const otherSiblingIds = siblingProviderIds.filter(id => id !== providerId);
    if (otherSiblingIds.length > 0) passes.push(otherSiblingIds);

    for (const ids of passes) {
      const seriesRows = db.prepare(`
        SELECT provider_id, remote_stream_id, metadata FROM provider_channels
        WHERE provider_id IN (${ids.map(() => '?').join(',')}) AND stream_type = 'series'
      `).iterate(...ids);
      for (const row of seriesRows) {
        const sid = Number(row.remote_stream_id);
        if (!sid || seen.has(sid)) continue;
        let lastModified = '';
        let fromM3u = false;
        try {
          const meta = JSON.parse(row.metadata || '{}');
          if (meta.last_modified !== undefined && meta.last_modified !== null) lastModified = String(meta.last_modified);
          // Entries parsed from an M3U playlist have no Xtream API behind them;
          // get_series_info would fail on every sync, so never queue them.
          if (meta.original_url) fromM3u = true;
        } catch { /* ignore malformed metadata */ }
        // Skip the row, not the series: a sibling may carry the same series as a
        // real Xtream entry that can be fetched.
        //
        // Claiming the id here would not be an entitlement boundary. Episodes are
        // read back by source_key alone (see xtreamController), so the moment any
        // provider of this panel fetches the series, every provider of it resolves
        // those episodes — whether this run fetched them or not. Claiming would
        // only decide which provider happens to trigger the fetch, at the price of
        // never fetching the series at all whenever the M3U row sorts first.
        if (fromM3u) continue;
        const credential = credentials.get(row.provider_id);
        if (!credential) continue;
        seen.add(sid);
        totalSeries++;

        const providerId_ = row.provider_id;
        const state = stateMap.get(sid);
        if (!state) {
          queue.push({ sid, lastModified, credential, providerId: providerId_ });
        } else if (lastModified) {
          if ((state.last_modified || '') !== lastModified) queue.push({ sid, lastModified, credential, providerId: providerId_ });
        } else if ((nowSec - (state.synced_at || 0)) >= EPISODE_SYNC_RETRY_AGE) {
          queue.push({ sid, lastModified, credential, providerId: providerId_ });
      }
      }
    }

    if (queue.length === 0) {
      console.debug(`Episode sync for source ${sourceKey}: everything up to date (${totalSeries} series)`);
      return { synced: 0, failed: 0, total: 0 };
    }
    console.info(`📺 Episode sync for source ${sourceKey} (triggered by ${provider.name}): ${queue.length}/${totalSeries} series to update`);

    const applySeries = createSeriesEpisodeWriter(sourceKey);

    let processed = 0;
    let failed = 0;
    let abandoned = 0;
    let episodeCount = 0;
    let cursor = 0;
    let dbFailures = 0;

    // The breaker counts per provider account, not per panel. One sibling whose
    // subscription lapsed answers every request with an error while the panel
    // itself is healthy; counting those against the panel would end the run for
    // every other account on it. And because a failed series never gets a state
    // row, that sibling's series are re-queued every cycle, so the panel would
    // be held back again and again on account of one dead login.
    const queuedProviders = new Set(queue.map(item => item.providerId));
    const failuresByProvider = new Map();
    const givenUpProviders = new Set();
    const noteUpstreamFailure = providerId => {
      const count = (failuresByProvider.get(providerId) || 0) + 1;
      failuresByProvider.set(providerId, count);
      if (count >= EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES) givenUpProviders.add(providerId);
      return count;
    };

    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        if (givenUpProviders.has(item.providerId)) { abandoned++; continue; }
        try {
          const count = await fetchSeriesEpisodesOnce(sourceKey, item.sid, () =>
            fetchSeriesEpisodes(item.credential.baseUrl, item.credential.authParams, item.sid, item.lastModified, applySeries)
          );
          if (count === null) {
            // A 200 carrying neither episodes nor info is the panel refusing
            // this account, not an empty series, so it belongs to the breaker
            // exactly like an HTTP error does.
            failed++;
            noteUpstreamFailure(item.providerId);
            continue;
          }
          episodeCount += count;
          processed++;
          failuresByProvider.set(item.providerId, 0);
          if (processed % 250 === 0) {
            console.info(`📺 Episode sync progress (${sourceKey}): ${processed}/${queue.length} series`);
          }
        } catch (e) {
          failed++;
          // Only an unanswering upstream trips the breaker. A local write
          // failure says the database is the problem, not the panel, and
          // aborting the queue for it would both drop the work and blame the
          // wrong side.
          if (e?.localFailure || isRetryableSqliteError(e)) {
            dbFailures++;
            console.debug(`Episode write failed for series ${item.sid}: ${formatDbError(e)}`);
            continue;
          }
          const count = noteUpstreamFailure(item.providerId);
          if (count <= EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES) {
            console.debug(`Episode fetch failed for series ${item.sid}: ${sanitizeErrorMessage(e)}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(EPISODE_SYNC_CONCURRENCY, queue.length) }, () => worker()));

    if (processed > 0) clearChannelsCache();
    // Only a panel that refused every account on it is the panel's fault, and
    // only that justifies holding the shared source back.
    const givenUp = queuedProviders.size > 0 && [...queuedProviders].every(id => givenUpProviders.has(id));
    if (givenUp) {
      cooldownSeconds = EPISODE_SYNC_GIVE_UP_COOLDOWN_SECONDS;
      console.warn(`⚠️ Episode sync for source ${sourceKey} gave up: every one of its ${queuedProviders.size} provider account(s)` +
        ` hit ${EPISODE_SYNC_MAX_CONSECUTIVE_FAILURES} consecutive upstream failures (${processed}/${queue.length} series updated).` +
        ` Holding the source back for ${cooldownSeconds}s so its providers do not repeat the run`);
    } else if (givenUpProviders.size > 0) {
      console.warn(`⚠️ Episode sync for source ${sourceKey}: ${givenUpProviders.size} of ${queuedProviders.size} provider account(s)` +
        ` stopped answering and were skipped (${processed}/${queue.length} series updated); the panel itself still answers`);
    } else {
      console.info(`✅ Episode sync completed for source ${sourceKey}: ${processed} series updated (${episodeCount} episodes), ${failed} failed`);
    }
    if (dbFailures > 0) {
      console.warn(`Episode sync for provider ${provider.name}: ${dbFailures} write(s) lost to database contention`);
    }
    return {
      synced: processed, failed, abandoned, dbFailures, total: queue.length,
      gaveUp: givenUp, gaveUpProviders: givenUpProviders.size,
    };
  } finally {
    episodeSyncLocks.delete(sourceKey);
    sourceLock.release(cooldownSeconds);
  }
}
