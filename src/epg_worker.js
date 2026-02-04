import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { parseEpgChannels } from './epg_utils.js';
import { ChannelMatcher } from './channel_matcher.js';

export function matchChannels(channels, allEpgChannels, globalMappings) {
    const updates = [];
    let matched = 0;

    const matcher = new ChannelMatcher(allEpgChannels);

    for (const ch of channels) {
       const result = matcher.match(ch.name);

       if (result.epgChannel) {
         // console.log(`MATCHED: "${ch.name}" -> "${result.epgChannel.id}" (Method: ${result.method})`);
         updates.push({pid: ch.id, eid: result.epgChannel.id});
         matched++;
       } else {
         // console.log(`NO MATCH: "${ch.name}"`);
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
