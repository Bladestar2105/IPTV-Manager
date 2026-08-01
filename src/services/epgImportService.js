import zlib from 'zlib';
import { Transform } from 'stream';
import Database from 'better-sqlite3';
import XmlStream from 'node-xml-stream';
import mainDb from '../database/db.js';
import { fetchSafe } from '../utils/network.js';
import { decodeXml } from '../utils/epgUtils.js';
import { EPG_DB_PATH } from '../config/constants.js';
import { invalidateEpgLogosCache } from './logoResolver.js';

function decodeXmlIfNeeded(value) {
    if (!value) return '';
    return value.includes('&') ? decodeXml(value) : value;
}

export async function importEpgFromUrl(url, sourceType, sourceId) {
    console.debug(`📡 Fetching EPG for ${sourceType} ${sourceId} from: ${url}`);
    // fetchSafe performs isSafeUrl check
    const response = await fetchSafe(url, { allowSelfSigned: true });
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
            INSERT OR REPLACE INTO epg_channels (id, name, logo, source_type, source_id, updated_at)
            VALUES (@id, @name, @logo, @sourceType, @sourceId, @updatedAt)
        `);

        const insertProgram = importDb.prepare(`
            INSERT OR IGNORE INTO epg_programs (channel_id, source_type, source_id, start, stop, title, desc, lang)
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

        // Invalidate EPG logos cache after successful update
        invalidateEpgLogosCache();

        console.info(`✅ EPG updated for ${sourceType} ${sourceId}`);
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


