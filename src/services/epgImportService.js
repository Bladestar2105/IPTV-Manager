import zlib from 'zlib';
import { randomUUID } from 'crypto';
import { Transform } from 'stream';
import XmlStream from 'node-xml-stream';
import mainDb from '../database/db.js';
import { fetchSafe, resolveMaxRequestDurationMs } from '../utils/network.js';
import { decodeXml } from '../utils/epgUtils.js';
import { EPG_DB_PATH } from '../config/constants.js';
import { openSqliteConnection } from '../database/sqliteConnection.js';
import { immediateTransaction } from '../database/sqliteWrites.js';
import { invalidateEpgLogosCache } from './logoResolver.js';

function decodeXmlIfNeeded(value) {
    if (!value) return '';
    return value.includes('&') ? decodeXml(value) : value;
}

export const EPG_STAGE_PREFIX = 'epg_stage_';

// An import cannot legitimately run this long: HTTP_MAX_REQUEST_MS caps one
// download, so anything older than a wide multiple of that budget is abandoned.
const DEFAULT_STAGE_STALE_MS = 6 * 60 * 60 * 1000;
const STAGE_STALE_REQUEST_FACTOR = 4;

/**
 * Age after which a leftover staging table counts as abandoned.
 *
 * The floor is derived from the request budget instead of being a fixed
 * constant: the sweep must never classify a live import of another process as
 * stale, and that import can legitimately keep a body open for the whole of
 * HTTP_MAX_REQUEST_MS. The two settings are therefore not independent.
 */
export function resolveStageStaleMs(raw = process.env.EPG_STAGE_STALE_MS) {
    const floor = Math.max(60000, resolveMaxRequestDurationMs() * STAGE_STALE_REQUEST_FACTOR);
    const parsed = Number.parseInt(raw, 10);
    const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STAGE_STALE_MS;
    return Math.max(requested, floor);
}

/**
 * Staging table names for one import run.
 *
 * The names carry the run's start time and a per-run token: two updates of the
 * same source can overlap — a scheduled provider update and the fire-and-forget
 * update after a manual sync — and shared names would let one run drop the
 * tables another is still filling. The timestamp additionally lets the startup
 * sweep tell an abandoned table from one another process is still filling.
 * sourceType and sourceId are validated because they end up in DDL.
 */
export function stagingTableNames(sourceType, sourceId, runToken = randomUUID(), startedAtMs = Date.now()) {
    const type = String(sourceType).replace(/[^a-z]/gi, '').toLowerCase();
    const id = Number(sourceId);
    const token = String(runToken).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32);
    const started = Number(startedAtMs);
    if (!type || !Number.isInteger(id) || id < 0 || !token || !Number.isFinite(started) || started <= 0) {
        throw new Error(`Invalid EPG source identity: ${sourceType}/${sourceId}`);
    }
    const stamp = Math.floor(started).toString(36);
    return {
        channels: `${EPG_STAGE_PREFIX}channels_${type}_${id}_${stamp}_${token}`,
        programs: `${EPG_STAGE_PREFIX}programs_${type}_${id}_${stamp}_${token}`,
    };
}

/** Start time encoded in a staging table name, or null when it has none. */
export function stagingTableStartedAt(name) {
    const parts = String(name).split('_');
    if (parts.length < 3) return null;
    const stamp = parseInt(parts[parts.length - 2], 36);
    return Number.isFinite(stamp) && stamp > 0 ? stamp : null;
}

/**
 * Remove staging tables an abandoned run left behind.
 *
 * Having no workers in this primary does not mean no import is running: during
 * an overlapping restart another process may share DATA_DIR and still be
 * filling its tables. Only tables whose encoded start time is older than the
 * stale threshold are dropped, so a live import is never touched.
 */
export function dropOrphanedStagingTables(database, options = {}) {
    const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
    const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : resolveStageStaleMs();
    try {
        const rows = database.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? || '%'"
        ).all(EPG_STAGE_PREFIX);
        let dropped = 0;
        for (const row of rows) {
            const startedAt = stagingTableStartedAt(row.name);
            // A name without a usable timestamp cannot belong to a run of this
            // code, so it is abandoned by definition.
            if (startedAt !== null && now - startedAt <= staleMs) continue;
            database.exec(`DROP TABLE IF EXISTS ${row.name};`);
            dropped++;
        }
        return dropped;
    } catch (e) {
        console.warn(`Could not sweep EPG staging tables: ${e.message}`);
        return 0;
    }
}

/**
 * Bookkeeping for promotion order. Created here as well as in initEpgDb because
 * the import owns its own connection and must not depend on startup order.
 */
export function ensureImportStateTable(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS epg_import_state (
            source_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            promoted_at INTEGER NOT NULL DEFAULT 0,
            promoted_seq INTEGER NOT NULL DEFAULT 0,
            claimed_seq INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source_type, source_id)
        );
    `);
}

/**
 * Claim the next promotion sequence for a source.
 *
 * A millisecond timestamp is not usable here: two workers can start within the
 * same millisecond, and a clock that steps back inverts the order outright. The
 * counter is issued by the database inside one transaction, so it is strictly
 * monotonic per source no matter how many processes are involved.
 */
export function claimPromotionSequence(database, sourceType, sourceId) {
    return immediateTransaction(database, () => {
        // MAX(claimed_seq, promoted_seq) + 1, not claimed_seq + 1: a writer from
        // the timestamp-based build can promote after the migration rebased the
        // counter, leaving promoted_seq far above it. Rebasing on every claim
        // means such a writer cannot make the source unpromotable again.
        const row = database.prepare(`
            INSERT INTO epg_import_state (source_type, source_id, promoted_at, promoted_seq, claimed_seq)
            VALUES (?, ?, 0, 0, 1)
            ON CONFLICT(source_type, source_id) DO UPDATE SET
                claimed_seq = MAX(claimed_seq, promoted_seq) + 1
            RETURNING claimed_seq
        `).get(sourceType, sourceId);
        const claimed = Number(row?.claimed_seq);
        if (!Number.isFinite(claimed) || claimed <= 0) {
            throw new Error('Could not claim an EPG promotion sequence');
        }
        return claimed;
    })();
}

function createStagingTables(database, stage) {
    database.exec(`
        CREATE TABLE ${stage.channels} (
            id TEXT NOT NULL,
            name TEXT,
            logo TEXT,
            source_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            updated_at INTEGER,
            PRIMARY KEY (id, source_type, source_id)
        );
        CREATE TABLE ${stage.programs} (
            channel_id TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id INTEGER NOT NULL,
            start INTEGER NOT NULL,
            stop INTEGER NOT NULL,
            title TEXT,
            desc TEXT,
            lang TEXT,
            PRIMARY KEY (channel_id, source_type, source_id, start)
        );
    `);
}

function dropStagingTables(database, stage) {
    if (!stage) return;
    try {
        database.exec(`DROP TABLE IF EXISTS ${stage.programs}; DROP TABLE IF EXISTS ${stage.channels};`);
    } catch (e) {
        console.warn(`Could not drop EPG staging tables: ${e.message}`);
    }
}

/**
 * Replace the live rows of one source with the staged import, in one
 * transaction. Until this runs, the previous EPG data stays queryable.
 */
function promoteStagedEpg(database, stage, sourceType, sourceId, runSeq) {
    const count = sql => Number(database.prepare(sql).get()?.c) || 0;
    return immediateTransaction(database, () => {
        // Per-run staging tables keep two overlapping imports from dropping each
        // other's data, but promotion still has to be ordered: a slower run that
        // started earlier must not overwrite the newer snapshot with its older
        // feed. The sequence is the run's start time in milliseconds.
        const promoted = database.prepare(
            'SELECT promoted_seq FROM epg_import_state WHERE source_type = ? AND source_id = ?'
        ).get(sourceType, sourceId);
        if (promoted && Number(promoted.promoted_seq) >= runSeq) {
            throw new Error('A newer EPG import already promoted this source; discarding the older snapshot');
        }

        const staged = {
            channels: count(`SELECT COUNT(*) AS c FROM ${stage.channels}`),
            programs: count(`SELECT COUNT(*) AS c FROM ${stage.programs}`),
        };
        const live = Number(
            database.prepare('SELECT COUNT(*) AS c FROM epg_channels WHERE source_type = ? AND source_id = ?')
                .get(sourceType, sourceId)?.c
        ) || 0;

        // An empty feed is a failed download far more often than a source that
        // genuinely lost all its data. Never trade existing EPG data for it.
        if (staged.channels === 0 && staged.programs === 0 && live > 0) {
            throw new Error('EPG feed delivered no channels or programmes; keeping the previous data');
        }

        database.prepare('DELETE FROM epg_programs WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
        database.prepare('DELETE FROM epg_channels WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
        database.prepare(`
            INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
            SELECT id, name, logo, source_type, source_id, updated_at FROM ${stage.channels}
        `).run();
        database.prepare(`
            INSERT OR IGNORE INTO epg_programs (channel_id, source_type, source_id, start, stop, title, desc, lang)
            SELECT channel_id, source_type, source_id, start, stop, title, desc, lang FROM ${stage.programs}
        `).run();
        database.prepare(`
            INSERT INTO epg_import_state (source_type, source_id, promoted_at, promoted_seq)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(source_type, source_id) DO UPDATE SET
                promoted_at = excluded.promoted_at,
                promoted_seq = excluded.promoted_seq
        `).run(sourceType, sourceId, Math.floor(Date.now() / 1000), runSeq);
        return staged;
    })();
}

export async function importEpgFromUrl(url, sourceType, sourceId) {
    // Dedicated connection for the import so the large batches do not block the
    // shared one. Foreign keys stay OFF: programs may arrive before their
    // channel, and `INSERT OR REPLACE INTO epg_channels` would otherwise cascade
    // the delete into the programs that were just written.
    // The shared factory supplies busy_timeout; a bare `new Database(path)` left
    // it at 0, which made every collision an immediate "database is locked".
    const importDb = openSqliteConnection(EPG_DB_PATH, { foreignKeys: false });

    // The staging tables are unique per run, so two concurrent updates of the
    // same source cannot drop each other's tables.
    let stage = null;

    try {
        ensureImportStateTable(importDb);

        // Claimed before the first network wait: the sequence has to reflect the
        // order the runs *started*. Taken after the fetch, a run whose headers
        // arrive late would get the higher sequence and could overwrite a
        // snapshot from a run that actually started later.
        const runSeq = claimPromotionSequence(importDb, sourceType, sourceId);
        stage = stagingTableNames(sourceType, sourceId);

        console.debug(`📡 Fetching EPG for ${sourceType} ${sourceId} from: ${url}`);
        // fetchSafe performs isSafeUrl check
        const response = await fetchSafe(url, { allowSelfSigned: true });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        // Update status in main DB
        if (sourceType === 'custom') {
            mainDb.prepare('UPDATE epg_sources SET is_updating = 1 WHERE id = ?').run(sourceId);
        }

        const now = Math.floor(Date.now() / 1000);

        createStagingTables(importDb, stage);

        let stream = response.body;

        // Check for GZIP signature (magic bytes 0x1f 0x8b)
        try {
            const [chunk, originalStream] = await peekStream(stream);
            if (chunk && chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
                console.debug(`📦 Detected GZIP stream for ${sourceType} ${sourceId}, decompressing...`);

                const MAX_EPG_UNCOMPRESSED_SIZE = 500 * 1024 * 1024; // 500MB
                let decompressedSize = 0;
                const gunzip = zlib.createGunzip();

                // Security Enhancement: Prevent Zip Bomb / DoS memory exhaustion
                const sizeChecker = new Transform({
                    transform(dataChunk, encoding, callback) {
                        decompressedSize += dataChunk.length;
                        if (decompressedSize > MAX_EPG_UNCOMPRESSED_SIZE) {
                            callback(new Error('Uncompressed EPG data exceeds 500MB limit (potential Zip Bomb)'));
                        } else {
                            callback(null, dataChunk);
                        }
                    }
                });

                originalStream.pipe(gunzip).pipe(sizeChecker);
                gunzip.on('error', (err) => {
                    sizeChecker.destroy(err);
                });
                stream = sizeChecker;
            } else {
                stream = originalStream;
            }
        } catch (e) {
            console.warn(`⚠️ Failed to peek stream, proceeding as plain text: ${e.message}`);
        }

        const insertChannel = importDb.prepare(`
            INSERT OR REPLACE INTO ${stage.channels} (id, name, logo, source_type, source_id, updated_at)
            VALUES (@id, @name, @logo, @sourceType, @sourceId, @updatedAt)
        `);

        const insertProgram = importDb.prepare(`
            INSERT OR IGNORE INTO ${stage.programs} (channel_id, source_type, source_id, start, stop, title, desc, lang)
            VALUES (@channelId, @sourceType, @sourceId, @start, @stop, @title, @desc, @lang)
        `);

        let channelBatch = [];
        let programBatch = [];
        const BATCH_SIZE = 2000;

        const processBatchTx = importDb.transaction((channelsToInsert, programsToInsert) => {
            for (const ch of channelsToInsert) insertChannel.run(ch);
            for (const prog of programsToInsert) insertProgram.run(prog);
        });

        const processBatches = () => {
            if (channelBatch.length > 0 || programBatch.length > 0) {
                processBatchTx(channelBatch, programBatch);
                channelBatch.length = 0;
                programBatch.length = 0;
            }
        };

        // Implement node-xml-stream for robust streaming XML parsing
        const parser = new XmlStream();

        let currentTag = null;
        let currentChannel = null;
        let currentProgram = null;
        let currentText = '';

        await new Promise((resolve, reject) => {
            parser.on('error', function (e) {
                console.error("XML Parse Error", e);
                reject(e);
            });

            parser.on('opentag', function (name, attrs) {
                currentTag = name;

                if (currentTag === 'display-name' || currentTag === 'title' || currentTag === 'desc') {
                    currentText = '';
                }

                if (name === 'channel') {
                    currentChannel = {
                        id: attrs.id,
                        name: attrs.id,
                        logo: null,
                        sourceType,
                        sourceId,
                        updatedAt: now,
                        hasName: false
                    };
                } else if (name === 'programme') {
                    const start = parseXmltvDate(attrs.start);
                    const stop = parseXmltvDate(attrs.stop);

                    if (stop > now - 86400) {
                        currentProgram = {
                            channelId: attrs.channel,
                            sourceType,
                            sourceId,
                            start,
                            stop,
                            title: '',
                            desc: '',
                            lang: ''
                        };
                    } else {
                        currentProgram = null;
                    }
                } else if (name === 'icon') {
                    if (currentChannel && attrs.src) {
                        // XML self-closing tags might include trailing slash in attrs.src if malformed by the parser, strip it just in case
                        let src = attrs.src.trim();
                        if (src.endsWith('/')) {
                             src = src.slice(0, -1).trim();
                        }
                        currentChannel.logo = src;
                    }
                }
            });

            const appendText = (text) => {
                 if (currentChannel && currentTag === 'display-name') {
                    currentText += text;
                } else if (currentProgram && (currentTag === 'title' || currentTag === 'desc')) {
                    currentText += text;
                }
            };

            parser.on('text', appendText);
            parser.on('cdata', appendText);

            parser.on('closetag', function (name) {
                if (currentChannel && name === 'display-name') {
                    if (!currentChannel.hasName) {
                        currentChannel.name = decodeXmlIfNeeded(currentText);
                        currentChannel.hasName = true;
                    }
                } else if (currentProgram && name === 'title') {
                    currentProgram.title = decodeXmlIfNeeded(currentText);
                } else if (currentProgram && name === 'desc') {
                    currentProgram.desc = decodeXmlIfNeeded(currentText);
                }

                if (name === 'channel' && currentChannel) {
                    delete currentChannel.hasName;
                    channelBatch.push(currentChannel);
                    currentChannel = null;
                } else if (name === 'programme' && currentProgram) {
                    if (currentProgram.channelId && currentProgram.start && currentProgram.stop && currentProgram.title) {
                        programBatch.push(currentProgram);
                    }
                    currentProgram = null;
                }

                if (channelBatch.length >= BATCH_SIZE || programBatch.length >= BATCH_SIZE) {
                    processBatches();
                }
            });

            parser.on('finish', function () {
                try {
                    processBatches();
                    resolve({ success: true });
                } catch (err) {
                    reject(err);
                }
            });

            stream.pipe(parser);

            stream.on('error', (err) => {
                if (err.message === 'unexpected end of file') {
                    console.warn(`⚠️ Ignoring unexpected end of file in GZIP stream for ${sourceType} ${sourceId}, saving parsed data...`);
                    try {
                        processBatches();
                        resolve({ success: true });
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(err);
                }
            });
        });

        // Cleanup orphaned programs after successful parsing
        importDb.prepare(`
            DELETE FROM ${stage.programs}
            WHERE channel_id NOT IN (SELECT id FROM ${stage.channels})
        `).run();

        const imported = promoteStagedEpg(importDb, stage, sourceType, sourceId, runSeq);

        if (sourceType === 'custom') {
            mainDb.prepare('UPDATE epg_sources SET last_update = ?, is_updating = 0 WHERE id = ?').run(now, sourceId);
        }

        // Invalidate EPG logos cache after successful update
        invalidateEpgLogosCache();

        console.info(`✅ EPG updated for ${sourceType} ${sourceId}: ${imported.channels} channels, ${imported.programs} programmes`);
        return { success: true, channels: imported.channels, programs: imported.programs };

    } catch (e) {
        console.error(`❌ EPG update failed: ${url}`, e.message);
        if (sourceType === 'custom') {
            mainDb.prepare('UPDATE epg_sources SET is_updating = 0 WHERE id = ?').run(sourceId);
        }
        throw e;
    } finally {
        // This run owns these exact names, so they are dropped unconditionally.
        if (stage) dropStagingTables(importDb, stage);
        importDb.close();
    }
}

// Helper: Parse XMLTV Date
function parseXmltvDate(dateStr) {
    if (!dateStr || dateStr.length < 14) return 0;

    const year = (dateStr.charCodeAt(0) - 48) * 1000 + (dateStr.charCodeAt(1) - 48) * 100 + (dateStr.charCodeAt(2) - 48) * 10 + (dateStr.charCodeAt(3) - 48);
    const month = (dateStr.charCodeAt(4) - 48) * 10 + (dateStr.charCodeAt(5) - 48) - 1;
    const day = (dateStr.charCodeAt(6) - 48) * 10 + (dateStr.charCodeAt(7) - 48);
    const hour = (dateStr.charCodeAt(8) - 48) * 10 + (dateStr.charCodeAt(9) - 48);
    const minute = (dateStr.charCodeAt(10) - 48) * 10 + (dateStr.charCodeAt(11) - 48);
    const second = (dateStr.charCodeAt(12) - 48) * 10 + (dateStr.charCodeAt(13) - 48);

    let ts = Date.UTC(year, month, day, hour, minute, second);

    if (dateStr.length > 14) {
        // Find timezone
        let tzIdx = 14;
        while (tzIdx < dateStr.length && dateStr.charCodeAt(tzIdx) === 32) { // space
            tzIdx++;
        }
        if (tzIdx + 4 < dateStr.length) {
            const signChar = dateStr.charCodeAt(tzIdx);
            if (signChar === 43 || signChar === 45) { // + or -
                const sign = signChar === 43 ? 1 : -1;
                const tzHour = (dateStr.charCodeAt(tzIdx + 1) - 48) * 10 + (dateStr.charCodeAt(tzIdx + 2) - 48);
                const tzMin = (dateStr.charCodeAt(tzIdx + 3) - 48) * 10 + (dateStr.charCodeAt(tzIdx + 4) - 48);
                const offsetMs = (tzHour * 60 + tzMin) * 60 * 1000 * sign;
                ts -= offsetMs;
            }
        }
    }
    return Math.floor(ts / 1000);
}

function peekStream(stream) {
    return new Promise((resolve, reject) => {
        const onData = (chunk) => {
            // Remove listeners to avoid double handling
            stream.removeListener('data', onData);
            stream.removeListener('error', onError);
            stream.removeListener('end', onEnd);

            // Pause stream to stop flow
            stream.pause();

            // Push chunk back to the front of the stream
            stream.unshift(chunk);

            resolve([chunk, stream]);
        };

        const onError = (err) => {
            stream.removeListener('data', onData);
            stream.removeListener('error', onError);
            stream.removeListener('end', onEnd);
            reject(err);
        };

        const onEnd = () => {
             stream.removeListener('data', onData);
             stream.removeListener('error', onError);
             stream.removeListener('end', onEnd);
             resolve([null, stream]);
        };

        stream.on('data', onData);
        stream.on('error', onError);
        stream.on('end', onEnd);
    });
}


