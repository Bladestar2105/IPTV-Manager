import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(process.cwd(), 'db.sqlite');
const CACHE_DIR = path.join(process.cwd(), 'cache');
const EPG_CACHE_DIR = path.join(CACHE_DIR, 'epg');
const SECRET_KEY_PATH = path.join(process.cwd(), 'secret.key');

if (!fs.existsSync(EPG_CACHE_DIR)) {
    fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });
}

// Encryption Setup (Matching server.js)
let ENCRYPTION_KEY;
if (fs.existsSync(SECRET_KEY_PATH)) {
    ENCRYPTION_KEY = fs.readFileSync(SECRET_KEY_PATH, 'utf8').trim();
} else {
    console.error('secret.key not found! Run server first.');
    process.exit(1);
}

// Ensure key is 32 bytes for AES-256
if (Buffer.from(ENCRYPTION_KEY, 'hex').length !== 32) {
  ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest('hex');
}

function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error('Encryption error:', e);
    return text;
  }
}

async function main() {
    console.log('Opening Database...');
    const db = new Database(DB_PATH);

    // 1. Create/Update Admin User
    const adminUser = 'admin';
    const adminPass = 'admin1234';
    const hashedPass = await bcrypt.hash(adminPass, 10);

    const existingAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(adminUser);
    if (existingAdmin) {
        db.prepare('UPDATE admin_users SET password = ? WHERE id = ?').run(hashedPass, existingAdmin.id);
        console.log('✅ Admin password updated to "admin1234"');
    } else {
        db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)').run(adminUser, hashedPass);
        console.log('✅ Admin user created with password "admin1234"');
    }

    // 2. Insert Provider
    const provName = 'German TV';
    const provUrl = 'http://dummy-provider.com'; // Dummy
    const provUser = 'user';
    const provPass = 'pass';
    const encryptedProvPass = encrypt(provPass);

    let provider = db.prepare('SELECT id FROM providers WHERE name = ?').get(provName);
    if (!provider) {
        const info = db.prepare(`
            INSERT INTO providers (name, url, username, password, epg_enabled, epg_update_interval)
            VALUES (?, ?, ?, ?, 1, 86400)
        `).run(provName, provUrl, provUser, encryptedProvPass);
        provider = { id: info.lastInsertRowid };
        console.log(`✅ Provider "${provName}" created (ID: ${provider.id})`);
    } else {
        console.log(`ℹ️ Provider "${provName}" already exists (ID: ${provider.id})`);
    }

    // 3. Insert Channels
    const channels = [
        { name: 'Das Erste HD', stream_id: 1001 },
        { name: 'ZDF HD', stream_id: 1002 },
        { name: 'RTL', stream_id: 1003 },
        { name: 'ProSieben', stream_id: 1004 },
        { name: 'Sat.1', stream_id: 1005 }
    ];

    const insertChannel = db.prepare(`
        INSERT OR IGNORE INTO provider_channels (provider_id, remote_stream_id, name, stream_type, original_sort_order)
        VALUES (?, ?, ?, 'live', ?)
    `);

    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        insertChannel.run(provider.id, ch.stream_id, ch.name, i);
    }
    console.log('✅ Channels inserted');

    // 4. Insert EPG Source
    const epgName = 'Germany 1';
    const epgUrl = 'https://www.open-epg.com/files/germany1.xml';

    let source = db.prepare('SELECT id FROM epg_sources WHERE url = ?').get(epgUrl);
    if (!source) {
        const info = db.prepare(`
            INSERT INTO epg_sources (name, url, enabled, update_interval)
            VALUES (?, ?, 1, 86400)
        `).run(epgName, epgUrl);
        source = { id: info.lastInsertRowid };
        console.log(`✅ EPG Source "${epgName}" added (ID: ${source.id})`);
    } else {
        console.log(`ℹ️ EPG Source "${epgName}" already exists (ID: ${source.id})`);
    }

    // 5. Fetch EPG XML
    console.log(`⬇️ Fetching EPG XML from ${epgUrl}...`);
    let xml = '';

    try {
        const res = await fetch(epgUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        xml = await res.text();
        console.log(`✅ EPG XML fetched (${xml.length} bytes)`);
    } catch (e) {
        console.warn(`⚠️ Failed to fetch real EPG: ${e.message}`);
        console.warn('⚠️ Generating DUMMY EPG for demonstration...');

        // Generate Dummy XML
        const now = new Date();
        const start = new Date(now.getTime() - 3600000).toISOString().replace(/[-:T]/g, '').slice(0,14) + ' +0000';
        const stop = new Date(now.getTime() + 3600000 * 5).toISOString().replace(/[-:T]/g, '').slice(0,14) + ' +0000';

        xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="DummyEPG">
  <channel id="daserste">
    <display-name>Das Erste</display-name>
  </channel>
  <channel id="zdf">
    <display-name>ZDF</display-name>
  </channel>
  <channel id="rtl">
    <display-name>RTL</display-name>
  </channel>
  <channel id="prosieben">
    <display-name>ProSieben</display-name>
  </channel>
  <channel id="sat1">
    <display-name>Sat.1</display-name>
  </channel>
  <programme start="${start}" stop="${stop}" channel="daserste">
    <title lang="de">Tagesschau</title>
    <desc lang="de">News program.</desc>
  </programme>
  <programme start="${start}" stop="${stop}" channel="zdf">
    <title lang="de">Heute Journal</title>
    <desc lang="de">News program.</desc>
  </programme>
  <programme start="${start}" stop="${stop}" channel="rtl">
    <title lang="de">RTL Aktuell</title>
    <desc lang="de">News program.</desc>
  </programme>
  <programme start="${start}" stop="${stop}" channel="prosieben">
    <title lang="de">Galileo</title>
    <desc lang="de">Science program.</desc>
  </programme>
  <programme start="${start}" stop="${stop}" channel="sat1">
    <title lang="de">Frühstücksfernsehen</title>
    <desc lang="de">Morning show.</desc>
  </programme>
</tv>`;
    }

    try {
        const cacheFile = path.join(EPG_CACHE_DIR, `epg_${source.id}.xml`);
        fs.writeFileSync(cacheFile, xml);
        console.log(`✅ EPG XML saved to ${cacheFile} (${xml.length} bytes)`);

        // 6. Parse and Map
        console.log('🔄 Mapping Channels...');

        const xmlChannelMap = new Map();
        const channelRegex = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
        let match;
        while ((match = channelRegex.exec(xml)) !== null) {
            const id = match[1];
            const inner = match[2];
            const nameMatch = inner.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
            if (nameMatch) {
                const name = nameMatch[1].toLowerCase().replace(/\s+/g, ''); // Normalize
                xmlChannelMap.set(name, id);
                xmlChannelMap.set(nameMatch[1].toLowerCase(), id);
            }
        }

        console.log(`ℹ️ Found ${xmlChannelMap.size} channels in XML`);

        const dbChannels = db.prepare('SELECT id, name FROM provider_channels WHERE provider_id = ?').all(provider.id);
        const updateEpgId = db.prepare('UPDATE provider_channels SET epg_channel_id = ? WHERE id = ?');

        let mappedCount = 0;
        for (const ch of dbChannels) {
            const target = ch.name.toLowerCase().replace(' hd', '').trim();
            const targetNorm = target.replace(/\s+/g, '');

            let epgId = xmlChannelMap.get(target) || xmlChannelMap.get(targetNorm);

            if (!epgId) {
                if (target.includes('das erste')) epgId = xmlChannelMap.get('daserste');
            }

            if (epgId) {
                updateEpgId.run(epgId, ch.id);
                console.log(`  🔗 Mapped "${ch.name}" -> ${epgId}`);
                mappedCount++;
            } else {
                console.log(`  ⚠️ Could not map "${ch.name}" (Target: ${target})`);
            }
        }
        console.log(`✅ Mapped ${mappedCount}/${dbChannels.length} channels`);

        // 7. Auto-add to user category
        const regUser = 'demo';
        const regPass = 'demo1234';
        const encRegPass = encrypt(regPass);

        let userRow = db.prepare('SELECT id FROM users WHERE username = ?').get(regUser);
        if (!userRow) {
            const info = db.prepare('INSERT INTO users (username, password, is_active) VALUES (?, ?, 1)').run(regUser, encRegPass);
            userRow = { id: info.lastInsertRowid };
            console.log(`✅ Created regular user "${regUser}" (ID: ${userRow.id})`);
        }

        // Now create a category for this user
        const catName = 'German TV';
        let userCat = db.prepare('SELECT id FROM user_categories WHERE user_id = ? AND name = ?').get(userRow.id, catName);
        if (!userCat) {
            const info = db.prepare("INSERT INTO user_categories (user_id, name, sort_order, type) VALUES (?, ?, 0, 'live')").run(userRow.id, catName);
            userCat = { id: info.lastInsertRowid };
            console.log(`✅ Created Category "${catName}" (ID: ${userCat.id})`);
        }

        // Add channels to this category
        const insertUserChannel = db.prepare('INSERT OR IGNORE INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');
        const provChannels = db.prepare('SELECT id FROM provider_channels WHERE provider_id = ?').all(provider.id);

        for (let i=0; i<provChannels.length; i++) {
             insertUserChannel.run(userCat.id, provChannels[i].id, i);
        }
        console.log(`✅ Added ${provChannels.length} channels to user category`);

        console.log('\nSETUP COMPLETE.');
        console.log(`User: ${regUser} / ${regPass}`);
        console.log(`Admin: ${adminUser} / ${adminPass}`);

    } catch (e) {
        console.error('Error in setup:', e);
    }
}

main();
