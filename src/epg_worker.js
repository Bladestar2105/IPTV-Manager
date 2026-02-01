import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { cleanName, levenshtein } from './epg_utils.js';

async function run() {
  const { channels, epgFiles, globalMappings } = workerData;
  const updates = [];

  try {
    // 1. Load EPG Channels
    const allEpgChannels = [];
    const seenIds = new Set();

    for (const item of epgFiles) {
      try {
        const content = await fs.promises.readFile(item.file, 'utf8');
        const channelRegex = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
        let match;
        while ((match = channelRegex.exec(content)) !== null) {
          const id = match[1];
          if (seenIds.has(id)) continue;

          const inner = match[2];
          const nameMatch = inner.match(/<display-name[^>]*>([^<]+)<\/display-name>/);

          if (nameMatch) {
             allEpgChannels.push({
               id: id,
               name: nameMatch[1]
             });
             seenIds.add(id);
          }
        }
      } catch (e) {
        // Ignore file errors in worker
      }
    }

    // 2. Build Lookup Maps
    const globalMap = new Map();
    for (const m of globalMappings) {
        const clean = cleanName(m.name);
        if (clean) globalMap.set(clean, m.epg_channel_id);
    }

    const epgChannelsMap = new Map();
    for (const ch of allEpgChannels) {
       if (ch.name) epgChannelsMap.set(cleanName(ch.name), ch.id);
    }

    // 3. Matching Logic
    let matched = 0;

    for (const ch of channels) {
       const cleaned = cleanName(ch.name);
       if (!cleaned) continue;

       // A. Global Map
       let epgId = globalMap.get(cleaned);

       // B. Exact Match
       if (!epgId) {
         epgId = epgChannelsMap.get(cleaned);
       }

       // C. Fuzzy Match (The CPU intensive part)
       if (!epgId) {
         for (const [epgName, id] of epgChannelsMap.entries()) {
           // Optimization: length diff check
           if (Math.abs(epgName.length - cleaned.length) > 3) continue;

           // Don't fuzzy match very short strings
           if (cleaned.length < 4) continue;

           if (levenshtein(cleaned, epgName) < 3) {
              epgId = id;
              break;
           }
         }
       }

       if (epgId) {
         updates.push({pid: ch.id, eid: epgId});
         matched++;
       }
    }

    parentPort.postMessage({ success: true, updates, matched });

  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
}

run();
