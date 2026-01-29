const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const MODE = process.argv[2] || 'default'; // 'default' or 'tuned'

const dbPath = path.join(__dirname, `benchmark_${MODE}.sqlite`);
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);

// Enable Foreign Keys (Matches server.js)
db.pragma('foreign_keys = ON');

// Initialize Schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

if (MODE === 'tuned') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    // db.pragma('cache_size = -64000'); // 64MB cache
}

// Load Data
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
const { channels, categories: providerCategories } = data;

// Setup Dummy Dependencies
const userId = 1;
const providerId = 1;

db.prepare('INSERT INTO users (id, username, password) VALUES (?, ?, ?)').run(userId, 'test', 'test');
db.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(providerId, 'Test Provider', 'http://test.com', 'user', 'pass', userId);


// Prepare Statements (copied/adapted from server.js)
const insertChannel = db.prepare(`
  INSERT OR IGNORE INTO provider_channels
  (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateChannel = db.prepare(`
  UPDATE provider_channels
  SET name = ?, original_category_id = ?, logo = ?, epg_channel_id = ?, original_sort_order = ?
  WHERE provider_id = ? AND remote_stream_id = ?
`);

// Simulation of "existing" check
const existingChannels = db.prepare('SELECT remote_stream_id, id FROM provider_channels WHERE provider_id = ?').all(providerId);
const existingMap = new Map();
for (const row of existingChannels) {
  existingMap.set(row.remote_stream_id, row.id);
}

// Category Mapping Logic (simplified for benchmark)
const categoryMap = new Map();
// Assume all categories are "new" for this benchmark
const insertCategoryMapping = db.prepare(`
    INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
    VALUES (?, ?, ?, ?, ?, ?)
`);
const insertUserCategory = db.prepare('INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (?, ?, ?, ?)');

console.log(`Starting Benchmark: ${MODE.toUpperCase()} with ${channels.length} channels...`);
const start = process.hrtime();

// Transaction logic from server.js
const runTransaction = db.transaction(() => {
    // 1. Process Categories
    for (const provCat of providerCategories) {
        const catId = Number(provCat.category_id);
        const catName = provCat.category_name;

        // Simulate auto-create
        const catInfo = insertUserCategory.run(userId, catName, 0, 0);
        const newCategoryId = catInfo.lastInsertRowid;

        insertCategoryMapping.run(providerId, userId, catId, catName, newCategoryId, 1);
        categoryMap.set(catId, newCategoryId);
    }

    // 2. Process Channels
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const sid = Number(ch.stream_id);
        const existingId = existingMap.get(sid);

        if (existingId) {
            updateChannel.run(
                ch.name,
                Number(ch.category_id),
                ch.stream_icon,
                ch.epg_channel_id,
                i,
                providerId,
                sid
            );
        } else {
            insertChannel.run(
                providerId,
                sid,
                ch.name,
                Number(ch.category_id),
                ch.stream_icon,
                'live',
                ch.epg_channel_id,
                i
            );
        }
    }
});

runTransaction();

const end = process.hrtime(start);
const timeInMs = (end[0] * 1000 + end[1] / 1e6).toFixed(2);
const recordsPerSec = (channels.length / (timeInMs / 1000)).toFixed(0);

console.log(`Finished ${MODE}: ${timeInMs}ms`);
console.log(`Throughput: ${recordsPerSec} records/sec`);

// Verify
const count = db.prepare('SELECT COUNT(*) as c FROM provider_channels').get().c;
console.log(`Count in DB: ${count}`);
