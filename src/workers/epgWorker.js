import { parentPort, workerData } from 'worker_threads';
import { ChannelMatcher } from '../services/channelMatcher.js';
import { loadAllEpgChannels } from '../services/epgService.js';

export function matchChannels(channels, allEpgChannels = null) {
    const updates = [];
    let matched = 0;

    const matcher = new ChannelMatcher(allEpgChannels || []);

    for (const ch of channels) {
       // Automapping
       const result = matcher.match(ch.name, ch.epg_id);

       if (result.epgChannel) {
         updates.push({pid: ch.id, eid: result.epgChannel.id});
         matched++;
       }
    }

    return { updates, matched };
}

async function run() {
  if (!workerData) return; // Not running in worker thread

  const { channels } = workerData;

  try {
    const allEpgChannels = await loadAllEpgChannels();
    if (!allEpgChannels || allEpgChannels.length === 0) {
      parentPort.postMessage({ success: true, updates: [], matched: 0, epgEmpty: true });
      return;
    }

    const { updates, matched } = matchChannels(channels, allEpgChannels || []);
    parentPort.postMessage({ success: true, updates, matched });

  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
}

run();
