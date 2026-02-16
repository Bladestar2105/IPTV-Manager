import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { createWriteStream } from 'fs';
import db from '../database/db.js';
import { EPG_CACHE_DIR } from '../config/constants.js';
import { mergeEpgFiles, filterEpgFile, decodeXml, parseEpgChannels } from '../utils/epgUtils.js';
import { isSafeUrl } from '../utils/helpers.js';

if (!fs.existsSync(EPG_CACHE_DIR)) fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });

export function getEpgFiles() {
  const epgFiles = [];
  const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
  for (const provider of providers) {
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
    if (fs.existsSync(cacheFile)) {
      epgFiles.push({ file: cacheFile, source: `Provider ${provider.id}` });
    }
  }
  const sources = db.prepare('SELECT id, name FROM epg_sources WHERE enabled = 1').all();
  for (const source of sources) {
    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
    if (fs.existsSync(cacheFile)) {
      epgFiles.push({ file: cacheFile, source: source.name });
    }
  }
  return epgFiles;
}

export async function loadAllEpgChannels(files = null) {
  const epgFiles = files || getEpgFiles();
  const allChannels = [];
  const seenIds = new Set();

  for (const item of epgFiles) {
    try {
      await parseEpgChannels(item.file, (channel) => {
        if (seenIds.has(channel.id)) return;

        allChannels.push({
            id: channel.id,
            name: channel.name,
            logo: channel.logo,
            source: item.source
        });
        seenIds.add(channel.id);
      });
    } catch (e) {
      console.error(`Error reading EPG file ${item.file}:`, e);
    }
  }
  return allChannels;
}

export async function updateEpgSource(sourceId, skipRegenerate = false) {
  const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error('EPG source not found');

  db.prepare('UPDATE epg_sources SET is_updating = 1 WHERE id = ?').run(sourceId);

  try {
    console.log(`📡 Fetching EPG from: ${source.name}`);

    if (!(await isSafeUrl(source.url))) {
      throw new Error(`Unsafe URL blocked: ${source.url}`);
    }

    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const epgData = await response.text();
    const now = Math.floor(Date.now() / 1000);

    const cacheFile = path.join(EPG_CACHE_DIR, `epg_${sourceId}.xml`);
    await fs.promises.writeFile(cacheFile, epgData, 'utf8');

    db.prepare('UPDATE epg_sources SET last_update = ?, is_updating = 0 WHERE id = ?').run(now, sourceId);

    console.log(`✅ EPG updated: ${source.name} (${(epgData.length / 1024 / 1024).toFixed(2)} MB)`);

    if (!skipRegenerate) {
        await generateConsolidatedEpg();
    }

    return { success: true, size: epgData.length };
  } catch (e) {
    console.error(`❌ EPG update failed: ${source.name}`, e.message);
    db.prepare('UPDATE epg_sources SET is_updating = 0 WHERE id = ?').run(sourceId);
    throw e;
  }
}

export async function generateConsolidatedEpg() {
  const fullFile = path.join(EPG_CACHE_DIR, 'epg_full.xml');
  const filteredFile = path.join(EPG_CACHE_DIR, 'epg.xml');
  const tempFullFile = path.join(EPG_CACHE_DIR, `epg_full.xml.tmp.${crypto.randomUUID()}`);
  const tempFilteredFile = path.join(EPG_CACHE_DIR, `epg.xml.tmp.${crypto.randomUUID()}`);

  try {
    const epgFiles = [];

    const providers = db.prepare("SELECT id FROM providers WHERE epg_url IS NOT NULL AND TRIM(epg_url) != ''").all();
    for (const provider of providers) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_provider_${provider.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }

    const sources = db.prepare('SELECT id FROM epg_sources WHERE enabled = 1').all();
    for (const source of sources) {
      const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
      if (fs.existsSync(cacheFile)) {
        epgFiles.push(cacheFile);
      }
    }

    console.log(`ℹ️ Generating Full EPG from ${epgFiles.length} sources`);
    const writeStreamFull = createWriteStream(tempFullFile);
    writeStreamFull.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');
    await mergeEpgFiles(epgFiles, writeStreamFull);
    writeStreamFull.write('</tv>');
    writeStreamFull.end();
    await new Promise((resolve, reject) => {
        writeStreamFull.on('finish', resolve);
        writeStreamFull.on('error', reject);
    });
    await fs.promises.rename(tempFullFile, fullFile);
    console.log('✅ Full Consolidated EPG generated');

    const usedIds = new Set();
    const mappings = db.prepare('SELECT DISTINCT epg_channel_id FROM epg_channel_mappings').all();
    mappings.forEach(r => { if(r.epg_channel_id) usedIds.add(r.epg_channel_id); });
    const direct = db.prepare("SELECT DISTINCT epg_channel_id FROM provider_channels WHERE epg_channel_id IS NOT NULL AND epg_channel_id != ''").all();
    direct.forEach(r => { if(r.epg_channel_id) usedIds.add(r.epg_channel_id); });

    console.log(`ℹ️ Generating Filtered EPG for ${usedIds.size} unique channels`);

    const writeStreamFiltered = createWriteStream(tempFilteredFile);
    writeStreamFiltered.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');
    await filterEpgFile(fullFile, writeStreamFiltered, usedIds);
    writeStreamFiltered.write('</tv>');
    writeStreamFiltered.end();
    await new Promise((resolve, reject) => {
        writeStreamFiltered.on('finish', resolve);
        writeStreamFiltered.on('error', reject);
    });
    await fs.promises.rename(tempFilteredFile, filteredFile);
    console.log('✅ Filtered Consolidated EPG generated');

  } catch (e) {
    console.error('Failed to regenerate consolidated EPG:', e);
    try { if (fs.existsSync(tempFullFile)) await fs.promises.unlink(tempFullFile); } catch (e) {}
    try { if (fs.existsSync(tempFilteredFile)) await fs.promises.unlink(tempFilteredFile); } catch (e) {}
  }
}

export async function streamEpgContent(file, outputStream) {
    if (!fs.existsSync(file)) return;

    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
        let buffer = '';
        let foundStart = false;

        stream.on('data', (chunk) => {
            let currentChunk = buffer + chunk;
            buffer = '';

            if (!foundStart) {
                const startMatch = currentChunk.match(/<tv[^>]*>/);
                if (startMatch) {
                    foundStart = true;
                    const startIndex = startMatch.index + startMatch[0].length;
                    currentChunk = currentChunk.substring(startIndex);
                } else {
                    const lastLt = currentChunk.lastIndexOf('<');
                    if (lastLt !== -1) {
                        buffer = currentChunk.substring(lastLt);
                    }
                    return;
                }
            }

            if (foundStart) {
                const endMatch = currentChunk.indexOf('</tv>');
                if (endMatch !== -1) {
                    outputStream.write(currentChunk.substring(0, endMatch));
                    stream.destroy();
                    resolve();
                    return;
                } else {
                    if (currentChunk.length >= 5) {
                        const toWrite = currentChunk.substring(0, currentChunk.length - 4);
                        outputStream.write(toWrite);
                        buffer = currentChunk.substring(currentChunk.length - 4);
                    } else {
                        buffer = currentChunk;
                    }
                }
            }
        });

        stream.on('end', () => {
            resolve();
        });

        stream.on('error', (err) => {
            console.error(`Error streaming EPG file ${file}:`, err.message);
            resolve();
        });
    });
}
