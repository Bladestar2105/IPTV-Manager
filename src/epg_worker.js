import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { parseEpgChannels, cleanName } from './epg_utils.js';
import { ChannelMatcher } from './channel_matcher.js';

export function matchChannels(channels, allEpgChannels, globalMappings) {
    const updates = [];
    let matched = 0;

    // 1. Build Global Map (History)
    const globalMap = new Map();
    if (globalMappings) {
        for (const m of globalMappings) {
            const clean = cleanName(m.name);
            if (clean) globalMap.set(clean, m.epg_channel_id);
        }
    }

    const matcher = new ChannelMatcher(allEpgChannels);

    for (const ch of channels) {
       const cleaned = cleanName(ch.name);

       // A. Prioritize Global Mappings
       if (cleaned && globalMap.has(cleaned)) {
           const epgId = globalMap.get(cleaned);
           updates.push({pid: ch.id, eid: epgId});
           matched++;
           continue;
       }

       // B. Automapping
       const result = matcher.match(ch.name);

       if (result.epgChannel) {
         updates.push({pid: ch.id, eid: result.epgChannel.id});
         matched++;
       }
    }

    return { updates, matched };
}

async function run() {
  if (!workerData) return; // Not running in worker thread

  const { channels, epgXmlFile, globalMappings } = workerData;

  try {
    // 1. Load EPG Channels
    const allEpgChannels = [];
    const seenIds = new Set();

    try {
      await parseEpgChannels(epgXmlFile, (channel) => {
        if (!seenIds.has(channel.id)) {
          allEpgChannels.push(channel);
          seenIds.add(channel.id);
        }
      });
    } catch (e) {
      // Ignore file errors
    }

    const { updates, matched } = matchChannels(channels, allEpgChannels, globalMappings);

    parentPort.postMessage({ success: true, updates, matched });

  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
}

run();
