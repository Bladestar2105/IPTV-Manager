
import Database from 'better-sqlite3';
import { performance } from 'perf_hooks';
import fs from 'fs';
import path from 'path';

const DB_PATH = 'bench_db.sqlite';
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);

// Create table WITHOUT indexes first (simulating the "issue" state described, if we assume migrations didn't run or we want to show the diff)
// Actually, let's replicate the EXACT structure in db.js (without migrations) to establish a "no index" baseline.
// Then we can apply the fix (adding indexes) and measure.

function setupDb(useIndexes) {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    const db = new Database(DB_PATH);

    db.exec(`
    CREATE TABLE user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    `);

    if (useIndexes) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_user_channels_cat_sort ON user_channels(user_category_id, sort_order)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_user_channels_prov ON user_channels(provider_channel_id)`);
    }

    return db;
}

function runBenchmark(useIndexes) {
    const db = setupDb(useIndexes);

    // Insert Data
    const insertStmt = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

    const BATCH_SIZE = 1000;
    const TOTAL_ROWS = 100000;
    const CATEGORIES = 100;
    const PROVIDER_CHANNELS = 50000;

    // console.log(`Inserting ${TOTAL_ROWS} rows...`);
    const startInsert = performance.now();
    db.transaction(() => {
        for (let i = 0; i < TOTAL_ROWS; i++) {
            insertStmt.run(
                Math.floor(Math.random() * CATEGORIES),
                Math.floor(Math.random() * PROVIDER_CHANNELS),
                i
            );
        }
    })();
    const endInsert = performance.now();
    // console.log(`Insert took ${(endInsert - startInsert).toFixed(2)}ms`);

    // Benchmark Queries

    // 1. Filter by user_category_id
    const startQ1 = performance.now();
    for (let i = 0; i < 100; i++) {
        db.prepare('SELECT * FROM user_channels WHERE user_category_id = ?').all(Math.floor(Math.random() * CATEGORIES));
    }
    const endQ1 = performance.now();

    // 2. Filter by provider_channel_id
    const startQ2 = performance.now();
    for (let i = 0; i < 100; i++) {
        db.prepare('SELECT * FROM user_channels WHERE provider_channel_id = ?').all(Math.floor(Math.random() * PROVIDER_CHANNELS));
    }
    const endQ2 = performance.now();

    // 3. Sort by sort_order
    const startQ3 = performance.now();
    for (let i = 0; i < 10; i++) {
       db.prepare('SELECT * FROM user_channels WHERE user_category_id = ? ORDER BY sort_order').all(Math.floor(Math.random() * CATEGORIES));
    }
    const endQ3 = performance.now();

    db.close();

    return {
        insert: endInsert - startInsert,
        q1: endQ1 - startQ1,
        q2: endQ2 - startQ2,
        q3: endQ3 - startQ3
    };
}

console.log("Running Benchmark WITHOUT Indexes...");
const resNoIndex = runBenchmark(false);
console.log(resNoIndex);

console.log("Running Benchmark WITH Indexes...");
const resIndex = runBenchmark(true);
console.log(resIndex);

console.log("\nImprovement:");
console.log(`Filter by user_category_id: ${(resNoIndex.q1 / resIndex.q1).toFixed(2)}x faster`);
console.log(`Filter by provider_channel_id: ${(resNoIndex.q2 / resIndex.q2).toFixed(2)}x faster`);
console.log(`Filter + Sort: ${(resNoIndex.q3 / resIndex.q3).toFixed(2)}x faster`);

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
