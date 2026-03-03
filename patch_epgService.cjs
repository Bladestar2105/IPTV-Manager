const fs = require('fs');

const file = 'src/services/epgService.js';
let content = fs.readFileSync(file, 'utf-8');

const newCode = `

export function clearEpgData() {
    console.log("🧹 Clearing EPG programs and channels from database...");

    // Explicitly begin transaction to ensure consistency
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM epg_programs').run();
        db.prepare('DELETE FROM epg_channels').run();

        // Note: epg_channel_mappings table is intentionally left alone to preserve mapping.
    });

    transaction();
    console.log("✅ EPG data cleared successfully.");
}
`;

content += newCode;

fs.writeFileSync(file, content, 'utf-8');
console.log('patched epgService.js');
