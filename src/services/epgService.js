import fetch from 'node-fetch';
import readline from 'readline';
import Database from 'better-sqlite3';
import db from '../database/epgDb.js';
import mainDb from '../database/db.js';
import { isSafeUrl } from '../utils/helpers.js';
import { decodeXml } from '../utils/epgUtils.js';
import { EPG_DB_PATH } from '../config/constants.js';

export async function importEpgFromUrl(url, sourceType, sourceId) {
    if (!(await isSafeUrl(url))) {
        throw new Error(`Unsafe URL blocked: ${url}`);
    }

    console.log(`📡 Fetching EPG for ${sourceType} ${sourceId} from: ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Update status in main DB
    if (sourceType === 'custom') {
        mainDb.prepare('UPDATE epg_sources SET is_updating = 1 WHERE id = ?').run(sourceId);
    }

    // Create dedicated connection for import to handle large transactions and foreign key checks
    const importDb = new Database(EPG_DB_PATH);
    // Disable Foreign Keys during import to allow inserting programs before channels or missing channels
    importDb.pragma('foreign_keys = OFF');
    importDb.pragma('journal_mode = WAL');

    const now = Math.floor(Date.now() / 1000);

    try {
        // Clear existing data for this source
        importDb.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
        importDb.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);

        const rl = readline.createInterface({
            input: response.body,
            crlfDelay: Infinity
        });

        const insertChannel = importDb.prepare(`
            INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
            VALUES (@id, @name, @logo, @sourceType, @sourceId, @updatedAt)
        `);

        const insertProgram = importDb.prepare(`
            INSERT OR IGNORE INTO epg_programs (channel_id, source_type, source_id, start, stop, title, desc, lang)
            VALUES (@channelId, @sourceType, @sourceId, @start, @stop, @title, @desc, @lang)
        `);

        let channelBatch = [];
        let programBatch = [];
        const BATCH_SIZE = 500;

        let buffer = '';
        let inChannel = false;
        let inProgram = false;

        const processBatches = () => {
            if (channelBatch.length > 0 || programBatch.length > 0) {
                const updateTx = importDb.transaction(() => {
                    for (const ch of channelBatch) insertChannel.run(ch);
                    for (const prog of programBatch) insertProgram.run(prog);
                });
                updateTx();
                channelBatch = [];
                programBatch = [];
            }
        };

        for await (const line of rl) {
            const trimmed = line.trim();

            // Channel Start
            if (!inChannel && !inProgram && trimmed.startsWith('<channel')) {
                inChannel = true;
                buffer = trimmed;
                if (trimmed.endsWith('/>') || trimmed.includes('</channel>')) {
                    // One-liner or ends on same line
                } else {
                    continue;
                }
            }

            // Programme Start
            if (!inChannel && !inProgram && trimmed.startsWith('<programme')) {
                inProgram = true;
                buffer = trimmed;
                if (trimmed.endsWith('/>') || trimmed.includes('</programme>')) {
                     // One-liner or ends on same line
                } else {
                    continue;
                }
            }

            if (inChannel) {
                if (buffer !== trimmed) buffer += ' ' + trimmed;

                if (buffer.includes('</channel>') || buffer.endsWith('/>')) {
                    inChannel = false;
                    // Parse Channel
                    const idMatch = buffer.match(/id=(["'])([\s\S]*?)\1/);
                    const nameMatch = buffer.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
                    const iconMatch = buffer.match(/<icon[^>]+src=(["'])([\s\S]*?)\1/);

                    if (idMatch) {
                        channelBatch.push({
                            id: idMatch[2],
                            name: nameMatch ? decodeXml(nameMatch[1]) : idMatch[2],
                            logo: iconMatch ? iconMatch[2] : null,
                            sourceType,
                            sourceId,
                            updatedAt: now
                        });
                    }
                    buffer = '';
                }
            }

            if (inProgram) {
                if (buffer !== trimmed) buffer += ' ' + trimmed;

                if (buffer.includes('</programme>') || buffer.endsWith('/>')) {
                    inProgram = false;
                    // Parse Programme
                    const startMatch = buffer.match(/start="([^"]+)"/);
                    const stopMatch = buffer.match(/stop="([^"]+)"/);
                    const channelMatch = buffer.match(/channel="([^"]+)"/);
                    const titleMatch = buffer.match(/<title[^>]*>([^<]+)<\/title>/);
                    const descMatch = buffer.match(/<desc[^>]*>([^<]+)<\/desc>/);

                    if (startMatch && stopMatch && channelMatch && titleMatch) {
                         const start = parseXmltvDate(startMatch[1]);
                         const stop = parseXmltvDate(stopMatch[1]);

                         // Skip programs that ended more than 24h ago to save DB space immediately
                         if (stop > now - 86400) {
                             programBatch.push({
                                 channelId: channelMatch[1],
                                 sourceType,
                                 sourceId,
                                 start,
                                 stop,
                                 title: decodeXml(titleMatch[1]),
                                 desc: descMatch ? decodeXml(descMatch[1]) : '',
                                 lang: '' // Language extraction if needed
                             });
                         }
                    }
                    buffer = '';
                }
            }

            if (channelBatch.length >= BATCH_SIZE || programBatch.length >= BATCH_SIZE) {
                processBatches();
            }
        }

        // Final batch
        processBatches();

        // Cleanup orphaned programs (programs without a valid channel in this source)
        // This is important because we disabled foreign keys during import
        importDb.prepare(`
            DELETE FROM epg_programs
            WHERE source_type = ? AND source_id = ?
            AND channel_id NOT IN (
                SELECT id FROM epg_channels
                WHERE source_type = ? AND source_id = ?
            )
        `).run(sourceType, sourceId, sourceType, sourceId);

        if (sourceType === 'custom') {
            mainDb.prepare('UPDATE epg_sources SET last_update = ?, is_updating = 0 WHERE id = ?').run(now, sourceId);
        }

        console.log(`✅ EPG updated for ${sourceType} ${sourceId}`);
        return { success: true };

    } catch (e) {
        console.error(`❌ EPG update failed: ${url}`, e.message);
        if (sourceType === 'custom') {
            mainDb.prepare('UPDATE epg_sources SET is_updating = 0 WHERE id = ?').run(sourceId);
        }
        throw e;
    } finally {
        importDb.close();
    }
}

export async function updateEpgSource(sourceId, skipPrune = false) {
    const source = mainDb.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
    if (!source) throw new Error('EPG source not found');

    await importEpgFromUrl(source.url, 'custom', sourceId);
    if (!skipPrune) pruneOldEpgData();
}

export async function updateProviderEpg(providerId, skipPrune = false) {
    const provider = mainDb.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
    if (!provider || !provider.epg_url) throw new Error('Provider EPG not found');

    await importEpgFromUrl(provider.epg_url, 'provider', providerId);
    if (!skipPrune) pruneOldEpgData();
}

export function pruneOldEpgData(days = 7) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 86400);
    const result = db.prepare('DELETE FROM epg_programs WHERE stop < ?').run(cutoff);
    console.log(`🧹 Pruned ${result.changes} old EPG programs`);
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

export async function getEpgPrograms(channelId, limit = 1000) {
    const now = Math.floor(Date.now() / 1000);
    // Get future/current programs
    return db.prepare(`
        SELECT start, stop, title, desc, lang, channel_id
        FROM epg_programs
        WHERE channel_id = ? AND stop > ?
        ORDER BY start ASC
        LIMIT ?
    `).all(channelId, now, limit);
}

export function getProgramsNow() {
    const now = Math.floor(Date.now() / 1000);
    return db.prepare(`
        SELECT channel_id, title, desc, start, stop
        FROM epg_programs
        WHERE start <= ? AND stop >= ?
    `).all(now, now);
}

export function getProgramsSchedule(start, end) {
    return db.prepare(`
        SELECT channel_id, title, desc, start, stop
        FROM epg_programs
        WHERE stop >= ? AND start <= ?
        ORDER BY start ASC
    `).all(start, end);
}

export function getLastEpgUpdate(sourceType, sourceId) {
    const row = db.prepare('SELECT MAX(updated_at) as last_update FROM epg_channels WHERE source_type = ? AND source_id = ?').get(sourceType, sourceId);
    return row ? row.last_update : 0;
}

export async function* getEpgXmlForChannels(channelIds) {
    // channelIds is a Set or Array of strings (xml_id)
    if (!channelIds || channelIds.size === 0) return;

    const ids = Array.from(channelIds);
    const BATCH_SIZE = 900; // SQLite limit

    // 1. Fetch Channels
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(',');
        const channels = db.prepare(`
            SELECT id, name, logo
            FROM epg_channels
            WHERE id IN (${placeholders})
            GROUP BY id
        `).all(batch);

        for (const ch of channels) {
            yield `<channel id="${escapeXml(ch.id)}">
    <display-name>${escapeXml(ch.name)}</display-name>
    <icon src="${escapeXml(ch.logo || '')}" />
  </channel>\n`;
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
        const placeholders = batch.map(() => '?').join(',');

        // We need to stream programs to avoid memory issues.
        // better-sqlite3 iterate() is good for this.
        const stmt = db.prepare(`
            SELECT start, stop, title, desc, channel_id
            FROM epg_programs
            WHERE channel_id IN (${placeholders})
            ORDER BY start ASC
        `);

        for (const prog of stmt.iterate(batch)) {
            yield `<programme start="${formatXmltvDate(prog.start)}" stop="${formatXmltvDate(prog.stop)}" channel="${escapeXml(prog.channel_id)}">
    <title>${escapeXml(prog.title)}</title>
    <desc>${escapeXml(prog.desc || '')}</desc>
  </programme>\n`;
        }
    }
}

// Helper: Escape XML
function escapeXml(unsafe) {
    if (!unsafe) return '';
    return unsafe.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// Helper: Parse XMLTV Date
function parseXmltvDate(dateStr) {
  if (!dateStr) return 0;
  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+\-]\d{4})?$/);
  if (!match) return 0;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  let date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (match[7]) {
      const tz = match[7];
      const sign = tz.charAt(0) === '+' ? 1 : -1;
      const tzHour = parseInt(tz.substring(1, 3), 10);
      const tzMin = parseInt(tz.substring(3, 5), 10);
      const offsetMs = (tzHour * 60 + tzMin) * 60 * 1000 * sign;
      date = new Date(date.getTime() - offsetMs);
  }
  return Math.floor(date.getTime() / 1000);
}

// Helper: Format XMLTV Date (UTC)
function formatXmltvDate(ts) {
    const date = new Date(ts * 1000);
    const pad = (n) => n.toString().padStart(2, '0');
    // Use UTC for simplicity: YYYYMMDDHHMMSS +0000
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

// Legacy exports to prevent crashes until controllers are updated
export async function generateConsolidatedEpg() {}
export async function regenerateFilteredEpg() {}
export async function getEpgFiles() { return []; }
