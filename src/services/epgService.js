import { acquireLock } from './providerLockService.js';
import db from '../database/epgDb.js';
import mainDb from '../database/db.js';
import { EPG_DB_PATH } from '../config/constants.js';
import { openSqliteConnection } from '../database/sqliteConnection.js';
import { deleteInBatches, formatDbError, immediateTransaction } from '../database/sqliteWrites.js';
import { invalidateEpgLogosCache } from './logoResolver.js';
import { getEpgRetentionDays, getProviderEpgChannels } from './epgRetentionService.js';

import { importEpgFromUrl } from './epgImportService.js';

export { importEpgFromUrl };

async function withEpgUpdateLock(type, id, update) {
    const lock = acquireLock(`epg:${type}:${id}`, 'epg');
    if (!lock) throw Object.assign(new Error('EPG update is already running or the database is busy'), {code: 'EPG_UPDATE_LOCKED'});
    try { return await update(); }
    finally { lock.release(); }
}

export async function updateEpgSource(sourceId, skipPrune = false, { scheduled = false } = {}) {
    return withEpgUpdateLock('custom', sourceId, async () => {
        const source = mainDb.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
        if (!source) throw new Error('EPG source not found');
        // Scheduler snapshots can predate a manual refresh, so recheck under the source lock.
        if (scheduled && (!source.enabled || Math.max(source.last_update || 0, source.last_attempt || 0)
            + source.update_interval > Math.floor(Date.now() / 1000))) return;

        await importEpgFromUrl(source.url, 'custom', sourceId);
        if (!skipPrune) pruneOldEpgData();
    });
}

export async function updateProviderEpg(providerId, skipPrune = false, { scheduled = false } = {}) {
    return withEpgUpdateLock('provider', providerId, async () => {
        const provider = mainDb.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
        if (!provider) throw new Error('Provider not found');

        // Explicitly check if EPG syncing is enabled for this provider
        if (!provider.epg_enabled) {
            console.debug(`⚠️ Skipping EPG update for disabled provider ${providerId}`);
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        if (scheduled && Math.max(provider.last_epg_update || 0, provider.last_epg_attempt || 0)
            + (provider.epg_update_interval || 86400) > now) return;

        try {
            if (provider.epg_url && provider.epg_url.trim() !== '') {
                await importEpgFromUrl(provider.epg_url, 'provider', providerId);
            } else {
                await importChannelsFromProvider(providerId);
            }

            mainDb.prepare('UPDATE providers SET last_epg_update = ? WHERE id = ?').run(now, providerId);
        } catch (e) {
            // Preserve the last successful update; scheduled retries use last_epg_attempt.
            throw e;
        }

        if (!skipPrune) pruneOldEpgData();
    });
}

async function importChannelsFromProvider(providerId) {
    const channels = getProviderEpgChannels(providerId);

    // Foreign keys stay OFF for the same reason as in epgImportService:
    // `INSERT OR REPLACE INTO epg_channels` would cascade into epg_programs.
    const importDb = openSqliteConnection(EPG_DB_PATH, { foreignKeys: false });
    const now = Math.floor(Date.now() / 1000);
    const retentionCutoff = now - getEpgRetentionDays() * 86400;
    const sourceType = 'provider';
    const sourceId = providerId;

    try {
        const deletePrograms = importDb.prepare(`DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?
            AND (stop > ? OR stop < ? OR stop <= start OR channel_id NOT IN (
                SELECT id FROM epg_channels WHERE source_type = ? AND source_id = ?))`);
        const deleteChannels = importDb.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?');
        const insertChannel = importDb.prepare(`
            INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
            VALUES (@id, @name, @logo, @sourceType, @sourceId, @updatedAt)
        `);

        // One transaction for the clear and the refill. They used to be
        // separate — two autocommitted deletes, then the inserts — so an insert
        // that failed, on SQLITE_BUSY as easily as anything else, left this
        // provider with no EPG channels at all until the next daily run
        // succeeded. The rows come from a local query, so the whole thing is
        // repeatable and belongs in one transaction.
        const replaceChannels = immediateTransaction(importDb, () => {
            deleteChannels.run(sourceType, sourceId);
            for (const ch of channels) {
                insertChannel.run({
                    id: ch.epg_channel_id,
                    name: ch.name,
                    logo: ch.logo,
                    sourceType,
                    sourceId,
                    updatedAt: now
                });
            }
            deletePrograms.run(sourceType, sourceId, now, retentionCutoff, sourceType, sourceId);
        });
        replaceChannels();

        // Invalidate EPG logos cache after importing channels
        invalidateEpgLogosCache();

        console.info(`✅ Imported ${channels.length} channels from provider ${providerId} into EPG DB`);
    } catch (e) {
        console.error(`❌ Failed to import channels from provider ${providerId}:`, formatDbError(e));
        throw e;
    } finally {
        importDb.close();
    }
}

/**
 * Drop programmes whose stop time is older than the retention window.
 *
 * Import completion and hourly maintenance can encounter a large backlog.
 * Short transactions bound each write lock and synchronous event-loop stall.
 */
export function pruneOldEpgData(days = 7) {
    const cutoff = Math.floor(Date.now() / 1000) - getEpgRetentionDays(days) * 86400;
    const removed = deleteInBatches(db, 'epg_programs', 'stop < ?', [cutoff]);
    if (removed > 0) console.info(`🧹 Pruned ${removed} old EPG programs`);
}

export function deleteEpgSourceData(sourceId, sourceType) {
    db.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
    db.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
}

export async function loadAllEpgChannels({ includeSourceId = false } = {}) {
    // Return all channels including source info
    const channels = db.prepare(`
        SELECT id, name, logo, source_type${includeSourceId ? ', source_id' : ''}
        FROM epg_channels
        ORDER BY name ASC
    `).all();
    return channels;
}

export function getEpgPrograms(channelId, limit = 1000, options = {}) {
    const rowLimit = Math.min(Math.max(Number(limit) || 1000, 1), 10000);

    if (options.includePast) {
        return db.prepare(`
            SELECT
                start, stop, title, desc, lang, channel_id,
                datetime(start, 'unixepoch') as start_fmt,
                datetime(stop, 'unixepoch') as stop_fmt
            FROM epg_programs
            WHERE channel_id = ?
            ORDER BY start ASC
            LIMIT ?
        `).iterate(channelId, rowLimit);
    }

    const now = Math.floor(Date.now() / 1000);
    // Iterate formatted rows without materializing the entire result in JavaScript.
    return db.prepare(`
        SELECT
            start, stop, title, desc, lang, channel_id,
            datetime(start, 'unixepoch') as start_fmt,
            datetime(stop, 'unixepoch') as stop_fmt
        FROM epg_programs
        WHERE channel_id = ? AND stop > ?
        ORDER BY start ASC
        LIMIT ?
    `).iterate(channelId, now, rowLimit);
}

export function getEpgProgramsForChannels(
    channelIds,
    start,
    end,
    limitPerChannel = 500,
    totalLimit = Number.POSITIVE_INFINITY
) {
    if (!channelIds || channelIds.size === 0 || channelIds.length === 0) {
        return new Map();
    }

    const ids = Array.from(channelIds)
        .filter(Boolean)
        .map((id) => String(id));
    if (ids.length === 0) return new Map();

    const result = new Map();
    const counts = new Map();
    const BATCH_SIZE = 900;
    let total = 0;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        if (total >= totalLimit) break;
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = Array(batch.length).fill('?').join(',');
        const stmt = db.prepare(`
            SELECT
                start, stop, title, desc, lang, channel_id,
                datetime(start, 'unixepoch') as start_fmt,
                datetime(stop, 'unixepoch') as stop_fmt
            FROM epg_programs
            WHERE channel_id IN (${placeholders}) AND stop > ? AND start < ?
            ORDER BY channel_id ASC, start ASC
        `);

        for (const row of stmt.iterate(...batch, start, end)) {
            const channelId = row.channel_id;
            const count = counts.get(channelId) || 0;
            if (count >= limitPerChannel) continue;

            if (!result.has(channelId)) result.set(channelId, []);
            result.get(channelId).push(row);
            counts.set(channelId, count + 1);
            total += 1;
            if (total >= totalLimit) break;
        }
    }

    return result;
}

export function getEpgProgramsPage(channelId, start, end, limit, offset) {
    return db.prepare(`
        SELECT start, stop, title, desc, lang, channel_id,
            datetime(start, 'unixepoch') as start_fmt,
            datetime(stop, 'unixepoch') as stop_fmt
        FROM epg_programs
        WHERE channel_id = ? AND stop > ? AND start < ?
        ORDER BY start ASC, rowid ASC
        LIMIT ? OFFSET ?
    `).all(channelId, start, end, limit, offset);
}

export function getProgramsNow() {
    const now = Math.floor(Date.now() / 1000);
    // Return the grouped JSON directly from SQLite.
    return db.prepare(`
        SELECT json_group_object(channel_id, json(program)) as json_data
        FROM (
            SELECT channel_id, json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop) as program
            FROM epg_programs
            WHERE start <= ? AND stop >= ?
            GROUP BY channel_id
        )
    `).get(now, now);
}

export function getProgramsSchedule(start, end) {
    // Order programmes before aggregation so each channel's JSON schedule is chronological.
    return db.prepare(`
        SELECT json_group_object(channel_id, json(programs)) as json_data
        FROM (
            SELECT channel_id, json_group_array(
                json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)
            ) as programs
            FROM (
                SELECT * FROM epg_programs
                WHERE stop >= ? AND start <= ?
                ORDER BY channel_id ASC, start ASC
            )
            GROUP BY channel_id
        )
    `).get(start, end);
}

export function getProgramsScheduleForChannels(start, end, channelIds) {
    if (!channelIds || channelIds.size === 0 || channelIds.length === 0) {
        return { json_data: '{}' };
    }

    const ids = Array.from(channelIds)
        .filter(Boolean)
        .map((id) => String(id));
    if (ids.length === 0) return { json_data: '{}' };

    const BATCH_SIZE = 900; // SQLite bind parameter limit safety
    const fragments = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = Array(batch.length).fill('?').join(',');
        const row = db.prepare(`
            SELECT json_group_object(channel_id, json(programs)) as json_data
            FROM (
                SELECT channel_id, json_group_array(
                    json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)
                ) as programs
                FROM (
                    SELECT channel_id, title, desc, start, stop
                    FROM epg_programs
                    WHERE channel_id IN (${placeholders}) AND stop >= ? AND start <= ?
                    ORDER BY channel_id ASC, start ASC
                )
                GROUP BY channel_id
            )
        `).get(...batch, start, end);

        const json = row && row.json_data;
        if (json && json !== '{}') {
            fragments.push(json.slice(1, -1));
        }
    }

    return { json_data: fragments.length > 0 ? `{${fragments.join(',')}}` : '{}' };
}

export function getLastEpgUpdate(sourceType, sourceId) {
    const row = db.prepare('SELECT MAX(updated_at) as last_update FROM epg_channels WHERE source_type = ? AND source_id = ?').get(sourceType, sourceId);
    return row && row.last_update ? row.last_update : 0;
}

export async function* getEpgXmlForChannels(channelIds, mapLogo = logo => logo) {
    // channelIds is a Set or Array of strings (xml_id)
    if (!channelIds || channelIds.size === 0) return;

    const ids = Array.from(channelIds);
    const BATCH_SIZE = 900; // Stay below the bind-parameter limit of supported SQLite builds.

    // Yield buffered XML chunks rather than one fragment per programme.
    let buffer = '';
    const FLUSH_LIMIT = 65536; // 64KB

    // 1. Fetch Channels
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = Array(batch.length).fill('?').join(',');
        const channels = db.prepare(`
            SELECT id, name, logo, source_type, source_id
            FROM epg_channels
            WHERE id IN (${placeholders})
            GROUP BY id
        `).all(batch);

        for (const ch of channels) {
            buffer += `<channel id="${escapeXml(ch.id)}">\n    <display-name>${escapeXml(ch.name)}</display-name>\n    <icon src="${escapeXml(mapLogo(ch.logo || '', ch))}" />\n  </channel>\n`;
            if (buffer.length >= FLUSH_LIMIT) {
                yield buffer;
                buffer = '';
            }
        }
    }

    // Export all retained programmes for these channels, including catch-up history.

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = Array(batch.length).fill('?').join(',');

        // Format timestamps in SQLite and iterate rows without buffering the full schedule.
        const stmt = db.prepare(`
            SELECT
                strftime('%Y%m%d%H%M%S +0000', start, 'unixepoch') as xmltv_start,
                strftime('%Y%m%d%H%M%S +0000', stop, 'unixepoch') as xmltv_stop,
                title, desc, channel_id
            FROM epg_programs
            WHERE channel_id IN (${placeholders})
            ORDER BY start ASC
        `);

        for (const prog of stmt.iterate(batch)) {
            buffer += `<programme start="${prog.xmltv_start}" stop="${prog.xmltv_stop}" channel="${escapeXml(prog.channel_id)}">\n    <title>${escapeXml(prog.title)}</title>\n    <desc>${escapeXml(prog.desc || '')}</desc>\n  </programme>\n`;
            if (buffer.length >= FLUSH_LIMIT) {
                yield buffer;
                buffer = '';
            }
        }
    }

    if (buffer.length > 0) {
        yield buffer;
    }
}

// Helper: Escape XML
const matchHtmlRegExp = /["'&<>]/;

function escapeXml(unsafe) {
  if (!unsafe) return '';
  const str = String(unsafe);
  const match = matchHtmlRegExp.exec(str);

  if (!match) {
    return str;
  }

  let escape;
  let html = '';
  let index = 0;
  let lastIndex = 0;

  for (index = match.index; index < str.length; index++) {
    switch (str.charCodeAt(index)) {
      case 34: // "
        escape = '&quot;';
        break;
      case 38: // &
        escape = '&amp;';
        break;
      case 39: // '
        escape = '&apos;';
        break;
      case 60: // <
        escape = '&lt;';
        break;
      case 62: // >
        escape = '&gt;';
        break;
      default:
        continue;
    }

    if (lastIndex !== index) {
      html += str.substring(lastIndex, index);
    }

    lastIndex = index + 1;
    html += escape;
  }

  return lastIndex !== index
    ? html + str.substring(lastIndex, index)
    : html;
}

export function clearEpgData() {
    console.info("🧹 Clearing EPG programs and channels from database...");

    // Explicitly begin transaction to ensure consistency
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM epg_programs').run();
        db.prepare('DELETE FROM epg_channels').run();

        // Note: epg_channel_mappings table is intentionally left alone to preserve mapping.
    });

    transaction();

    // Reset update status on sources
    mainDb.prepare('UPDATE epg_sources SET last_update = 0, is_updating = 0').run();

    // Invalidate EPG logos cache after clearing data
    invalidateEpgLogosCache();

    console.info("✅ EPG data cleared successfully.");
}
