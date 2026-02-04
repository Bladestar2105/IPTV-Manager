import { matchChannels } from './src/epg_worker.js';
import { parseEpgChannels } from './src/epg_utils.js';
import fs from 'fs';

// Wrapper to adapt data format
async function main() {
    // Check if files exist
    if (!fs.existsSync('provider_channels.json')) {
        console.error("Provider channels not found. Run fetch_real_channels.js first (or reuse if data exists).");
        // Mock data if file missing (or just fail)
        return;
    }

    const rawChannels = JSON.parse(fs.readFileSync('provider_channels.json', 'utf8'));
    // Adapt to format expected by worker: { id, name }
    const channels = rawChannels.map(c => ({
        id: c.stream_id,
        name: c.name
    }));

    const allEpgChannels = [];
    const seenIds = new Set();
    const epgFiles = ['temp_de.xml', 'temp_gr.xml'];

    for (const file of epgFiles) {
        if (fs.existsSync(file)) {
            await parseEpgChannels(file, (channel) => {
                if (!seenIds.has(channel.id)) {
                    allEpgChannels.push(channel);
                    seenIds.add(channel.id);
                }
            });
        }
    }
    console.log(`Loaded ${allEpgChannels.length} EPG channels.`);

    const result = matchChannels(channels, allEpgChannels, []);
    console.log(`Matched: ${result.matched} / ${channels.length}`);

    const map = new Map();
    result.updates.forEach(u => map.set(u.pid, u.eid));

    // Verification Logic
    const verify = (namePart) => {
        const matches = channels.filter(c => c.name.includes(namePart));
        console.log(`\nChecking "${namePart}" (${matches.length} found):`);
        matches.forEach(c => {
            const eid = map.get(c.id);
            const status = eid ? `MATCHED -> ${eid}` : "NO MATCH";
            console.log(`  ${c.name} : ${status}`);
        });
    };

    // DE Tests
    verify("RTL");
    verify("Cinema");

    // GR Tests (if any)
    verify("GR|");

    // Strict Number Tests (from previous logic)
    verify("Cinema 1");
    verify("Cinema 2");
}

main();
