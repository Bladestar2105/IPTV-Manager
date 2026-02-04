import { matchChannels } from './src/epg_worker.js';
import { parseEpgChannels } from './src/epg_utils.js';
import fs from 'fs';

// Wrapper to adapt data format
async function main() {
    // Check if files exist
    if (!fs.existsSync('provider_channels.json')) {
        console.error("Provider channels not found. Run fetch_real_channels.js first (or reuse if data exists).");
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
    // Using temp files if they exist, otherwise skipping (since cleanup might have happened)
    // For this verification, we rely on prior fetch or we just skip if files gone.
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

    // Mock global mappings
    const globalMappings = [];

    const result = matchChannels(channels, allEpgChannels, globalMappings);
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

    if (allEpgChannels.length > 0) {
        verify("RTL");
        verify("Cinema");
    }
}

main();
