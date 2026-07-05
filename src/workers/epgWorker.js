import { parentPort, workerData } from 'worker_threads';
import { ChannelMatcher } from '../services/channelMatcher.js';
import { loadAllEpgChannels } from '../services/epgService.js';

export function matchChannels(channels, allEpgChannels = null, onProgress = null) {
    const updates = [];
    let matched = 0;

    const matcher = new ChannelMatcher(allEpgChannels || []);
    let lastProgress = 10;

    channels.forEach((ch, index) => {
       // Automapping
       const result = matcher.match(ch.name, ch.epg_id);

       if (result.epgChannel) {
         updates.push({pid: ch.id, eid: result.epgChannel.id});
         matched++;
       }

       if (onProgress && channels.length > 0) {
         const progress = 10 + Math.floor(((index + 1) / channels.length) * 75);
         if (progress > lastProgress) {
           lastProgress = progress;
           onProgress(progress);
         }
       }
    });

    return { updates, matched };
}

async function run() {
  if (!workerData) return; // Not running in worker thread

  const { channels } = workerData;

  try {
    parentPort.postMessage({ type: 'progress', progress: 10 });
    const allEpgChannels = await loadAllEpgChannels();
    if (!allEpgChannels || allEpgChannels.length === 0) {
      parentPort.postMessage({ success: true, updates: [], matched: 0, epgEmpty: true });
      return;
    }

    const { updates, matched } = matchChannels(channels, allEpgChannels || [], progress => {
      parentPort.postMessage({ type: 'progress', progress });
    });
    parentPort.postMessage({ success: true, updates, matched });

  } catch (e) {
    parentPort.postMessage({ success: false, error: e.message });
  }
}

run();
