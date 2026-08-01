import Database from 'better-sqlite3';
import db from '../database/epgDb.js';
import mainDb from '../database/db.js';
import { EPG_DB_PATH } from '../config/constants.js';
import { invalidateEpgLogosCache } from './logoResolver.js';

import { importEpgFromUrl } from './epgImportService.js';

export { importEpgFromUrl };

export async function updateEpgSource(sourceId, skipPrune = false) {
    const source = mainDb.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
    if (!source) throw new Error('EPG source not found');

    await importEpgFromUrl(source.url, 'custom', sourceId);
    if (!skipPrune) pruneOldEpgData();
}

export async function updateProviderEpg(providerId, skipPrune = false) {
    const provider = mainDb.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider) throw new Error('Provider not found');

    // Explicitly check if EPG syncing is enabled for this provider
    if (!provider.epg_enabled) {
        console.debug(`⚠️ Skipping EPG update for disabled provider ${providerId}`);
        return;
    }

    const now = Math.floor(Date.now() / 1000);

    try {
        if (provider.epg_url && provider.epg_url.trim() !== '') {
            await importEpgFromUrl(provider.epg_url, 'provider', providerId);
        } else {
            await importChannelsFromProvider(providerId);
        }

        mainDb.prepare('UPDATE providers SET last_epg_update = ? WHERE id = ?').run(now, providerId);
    } catch (e) {
        // Even on error, we might want to update last_update to prevent immediate retry loop?
        // No, let scheduler handle backoff via failedUpdates map.
        throw e;
    }

    if (!skipPrune) pruneOldEpgData();
}

async function importChannelsFromProvider(providerId) {
    const channels = mainDb.prepare(`
        SELECT DISTINCT epg_channel_id, name, logo
        FROM provider_channels
        WHERE provider_id = ? AND epg_channel_id IS NOT NULL AND epg_channel_id != ''
    `).all(providerId);

    if (channels.length === 0) return;

    const importDb = new Database(EPG_DB_PATH);
    const now = Math.floor(Date.now() / 1000);
    const sourceType = 'provider';
    const sourceId = providerId;

    try {
        // Clear existing data for this source
        importDb.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
        importDb.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);

        const insertChannel = importDb.prepare(`
            INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
            VALUES (@id, @name, @logo, @sourceType, @sourceId, @updatedAt)
        `);

        const updateTx = importDb.transaction(() => {
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
        });
        updateTx();

        // Invalidate EPG logos cache after importing channels
        invalidateEpgLogosCache();

        console.info(`✅ Imported ${channels.length} channels from provider ${providerId} into EPG DB`);
    } catch (e) {
        console.error(`❌ Failed to import channels from provider ${providerId}:`, e.message);
        throw e;
    } finally {
        importDb.close();
    }
}

export function pruneOldEpgData(days = 7) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
    const result = db.prepare('DELETE FROM epg_programs WHERE stop < ?').run(cutoff);
    console.info(`🧹 Pruned ${result.changes} old EPG programs`);
}

export function deleteEpgSourceData(sourceId, sourceType) {
    db.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
    db.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
}

export async function loadAllEpgChannels() {
    // Return all channels including source info
    const channels = db.prepare(`
        SELECT id, name, logo, source_type
        FROM epg_channels
        ORDER BY name ASC
    `).all();
    return channels;
}

export function loadEpgChannelLogosMap() {
    const channels = db.prepare(`
        SELECT id, logo
        FROM epg_channels
        WHERE logo IS NOT NULL AND logo != ''
    `).all();

    const logoMap = new Map();
    for (const ch of channels) {
        logoMap.set(ch.id, ch.logo);
    }
    return logoMap;
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
    // ⚡ Bolt: Offload date formatting to SQLite using datetime() and use .iterate() to reduce V8 memory pressure.
    // 🎯 Why: Creating Date objects and manipulating strings in JS for every program row causes CPU and GC overhead. Loading large lists of program objects into V8 memory at once can cause memory spikes.
    // 📊 Impact: Significantly speeds up EPG endpoint and reduces memory allocations.
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

export function getProgramsNow() {
    const now = Math.floor(Date.now() / 1000);
    // ⚡ Bolt: Offload grouping to SQLite for faster execution and lower memory usage
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
    // ⚡ Bolt: Aggregate array directly in SQLite using json_group_array
    // This avoids creating thousands of intermediate objects in V8 memory.
    // Ensure chronological order via subquery before grouping.
    // ⚡ Bolt: Use ORDER BY channel_id ASC, start ASC to fully utilize idx_epg_programs_channel_start.
    // This eliminates two temporary B-trees (one for ORDER BY, one for GROUP BY) during execution.
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

export async function* getEpgXmlForChannels(channelIds) {
    // channelIds is a Set or Array of strings (xml_id)
    if (!channelIds || channelIds.size === 0) return;

    const ids = Array.from(channelIds);
    const BATCH_SIZE = 900; // SQLite limit

    // ⚡ Bolt: Buffer XML strings to avoid massive overhead of individual res.write calls per program
    // 🎯 Why: Tens of thousands of small `yield` strings severely block the Node event loop and network stack
    // 📊 Impact: Drastically increases XMLTV generation throughput and lowers CPU usage
    let buffer = '';
    const FLUSH_LIMIT = 65536; // 64KB

    // 1. Fetch Channels
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
        const placeholders = Array(batch.length).fill('?').join(',');
        const channels = db.prepare(`
            SELECT id, name, logo
            FROM epg_channels
            WHERE id IN (${placeholders})
            GROUP BY id
        `).all(batch);

        for (const ch of channels) {
            buffer += `<channel id="${escapeXml(ch.id)}">\n    <display-name>${escapeXml(ch.name)}</display-name>\n    <icon src="${escapeXml(ch.logo || '')}" />\n  </channel>\n`;
            if (buffer.length >= FLUSH_LIMIT) {
                yield buffer;
                buffer = '';
            }
        }
    }

    // 2. Fetch Programs (Current + Future + 24h past for catchup?)
    // User asked for catchup 7 days.
    // If this is for XMLTV export, we probably want 7 days history if available?
    // Or just "Now"? Usually XMLTV is for next 24-48h.
    // But user mentioned catchup.
    // Let's provide -1 day to +2 days for standard.
    // Or should I fetch everything in DB?
    // Since we prune DB to 7 days, returning everything is fine if the client handles it.
    // Let's stream everything in DB for these channels.

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        // ⚡ Bolt: Use Array(n).fill('?').join(',') instead of .map(() => '?') to avoid closure allocation overhead in V8
        const placeholders = Array(batch.length).fill('?').join(',');

        // We need to stream programs to avoid memory issues.
        // better-sqlite3 iterate() is good for this.
        // ⚡ Bolt: Offload XMLTV date formatting to SQLite strftime to eliminate V8 Date operations and string concatenations
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
