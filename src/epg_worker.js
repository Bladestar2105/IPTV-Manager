import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import { cleanName, levenshtein, getSimilarity, parseEpgChannels } from './epg_utils.js';

export function matchChannels(channels, allEpgChannels, globalMappings) {
    const updates = [];
    let matched = 0;

    // 2. Build Lookup Maps
    const globalMap = new Map();
    for (const m of globalMappings) {
        const clean = cleanName(m.name);
        if (clean) globalMap.set(clean, m.epg_channel_id);
    }

    // Improved Map: Store Array of candidates to handle collisions
    const epgChannelsMap = new Map(); // cleanName -> [{id, name}]
    const epgBuckets = new Map();     // prefix(2) -> [{id, name, cleanName}]

    for (const ch of allEpgChannels) {
       if (!ch.name) continue;
       const clean = cleanName(ch.name);
       if (!clean) continue;

       // Add to Exact Map
       if (!epgChannelsMap.has(clean)) epgChannelsMap.set(clean, []);
       epgChannelsMap.get(clean).push(ch);

       // Add to Buckets (for fuzzy)
       const prefix = clean.substring(0, 2);
       if (!epgBuckets.has(prefix)) epgBuckets.set(prefix, []);
       epgBuckets.get(prefix).push({ ...ch, cleanName: clean });
    }

    // 3. Matching Logic
    for (const ch of channels) {
       const cleaned = cleanName(ch.name);
       if (!cleaned) continue;

       let epgId = null;

       // A. Global Map
       // Prioritize global mappings (history)
       if (globalMap.has(cleaned)) {
           epgId = globalMap.get(cleaned);
       }

       // B. Exact Match
       if (!epgId) {
         const candidates = epgChannelsMap.get(cleaned);
         if (candidates) {
             // Disambiguate using Original Name Similarity
             // This solves "RTL (DE)" vs "RTL (NL)" if they both clean to "rtl"
             // We pick the one that is closest to the original input name
             let bestCand = null;
             let bestSim = -1;

             for (const cand of candidates) {
                 // Use case-insensitive original name similarity
                 const sim = getSimilarity(ch.name.toLowerCase(), cand.name.toLowerCase());
                 if (sim > bestSim) {
                     bestSim = sim;
                     bestCand = cand;
                 }
             }
             if (bestCand) epgId = bestCand.id;
         }
       }

       // C. Fuzzy Match (Optimized with Buckets & Threshold)
       if (!epgId) {
         // Don't fuzzy match very short strings
         if (cleaned.length < 3) continue;

         const prefix = cleaned.substring(0, 2);
         const candidates = epgBuckets.get(prefix);

         if (candidates) {
            let bestCand = null;
            let bestSim = 0.8;

            // Extract numbers from cleaned name for strict number matching
            const nameNums = cleaned.match(/\d+/g);

            for (const cand of candidates) {
                // Strict Number Check: If both have numbers, they must match exactly
                const candNums = cand.cleanName.match(/\d+/g);
                if (nameNums && candNums) {
                    // Check if arrays are same (order doesn't strictly matter but usually does in names)
                    // For simplicity, sort and join
                    const n1 = [...nameNums].sort().join(',');
                    const n2 = [...candNums].sort().join(',');
                    if (n1 !== n2) continue;
                } else if ((nameNums && !candNums) || (!nameNums && candNums)) {
                    // One has number, other doesn't.
                    // This is risky (e.g. "RTL" vs "RTL 2", "Cinema" vs "Cinema 1").
                    // We enforce that if one has numbers, the other must have them too?
                    // Or we penalize?
                    // Let's enforce strict number matching: if one has numbers, the other must have the same numbers.
                    // This implies: if one has numbers and other doesn't, it's a mismatch.
                    if (nameNums || candNums) continue;
                }

                // Calculate Similarity with dynamic threshold
                const sim = getSimilarity(cleaned, cand.cleanName, bestSim);

                if (sim >= bestSim) {
                    if (sim > bestSim) {
                        bestSim = sim;
                        bestCand = cand;
                    } else if (!bestCand) {
                        bestCand = cand;
                    }
                }
            }

            if (bestCand) {
                epgId = bestCand.id;
            }
         }
       }

       if (epgId) {
         updates.push({pid: ch.id, eid: epgId});
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
