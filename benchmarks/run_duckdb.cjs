const duckdb = require('duckdb');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'benchmark_duckdb.db');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new duckdb.Database(dbPath);
const con = db.connect();

const run = (query) => new Promise((resolve, reject) => {
    con.run(query, (err) => {
        if (err) reject(err); else resolve();
    });
});

const exec = (query) => new Promise((resolve, reject) => {
    con.exec(query, (err) => {
        if (err) reject(err); else resolve();
    });
});

async function main() {
    // Load Data
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
    const { channels, categories } = data;
    const providerId = 1;
    const userId = 1;

    console.log('Initializing DuckDB...');

    // Schema adaptations for DuckDB
    await exec(`
        CREATE SEQUENCE provider_channels_id_seq;
        CREATE TABLE provider_channels (
            id INTEGER DEFAULT nextval('provider_channels_id_seq'),
            provider_id INTEGER NOT NULL,
            remote_stream_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            original_category_id INTEGER DEFAULT 0,
            logo TEXT DEFAULT '',
            stream_type TEXT DEFAULT 'live',
            epg_channel_id TEXT DEFAULT '',
            original_sort_order INTEGER DEFAULT 0,
            PRIMARY KEY(id),
            UNIQUE(provider_id, remote_stream_id)
        );

        CREATE SEQUENCE user_categories_id_seq;
        CREATE TABLE user_categories (
            id INTEGER DEFAULT nextval('user_categories_id_seq'),
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            is_adult INTEGER DEFAULT 0,
            PRIMARY KEY(id)
        );

        CREATE SEQUENCE category_mappings_id_seq;
        CREATE TABLE category_mappings (
            id INTEGER DEFAULT nextval('category_mappings_id_seq'),
            provider_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            provider_category_id INTEGER NOT NULL,
            provider_category_name TEXT NOT NULL,
            user_category_id INTEGER,
            auto_created INTEGER DEFAULT 0,
            PRIMARY KEY(id),
            UNIQUE(provider_id, user_id, provider_category_id)
        );
    `);

    console.log(`Starting DuckDB Benchmark with ${channels.length} channels...`);
    const start = process.hrtime();

    // DuckDB handles concurrency differently.
    // In a real app, we'd probably use an Appender for bulk loading, but let's simulate app logic (inserts).
    // However, executing 50k individual async queries will be slow due to overhead.
    // We will use "INSERT INTO ... VALUES ..." with multiple rows per query (Batching)
    // to give it a fair "Optimized" chance, or use a prepared statement loop.

    // Let's try Prepared Statement loop to match SQLite logic (fair comparison of "Engine" for same logic).
    // Note: DuckDB's Node client might be slower for single-row inserts than SQLite's synchronous one.

    // Actually, to show "if we change to another DB", we assume we'd use that DB's strengths.
    // So batching is fair. But SQLite also supports batching.
    // Let's stick to the "loop" to see the overhead of the engine+driver.

    // Prepare Statements
    const insertChannelStmt = await new Promise((resolve, reject) => {
        con.prepare(`INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, logo, stream_type, epg_channel_id, original_sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, (err, stmt) => {
            if (err) reject(err); else resolve(stmt);
        });
    });

    // We wrap execution in a transaction
    await run('BEGIN TRANSACTION');

    // Process Categories
    for (const provCat of categories) {
         // Insert User Category
         // We need the ID back. DuckDB doesn't easily return returning ID in the same way.
         // For benchmark, we ignore the ID dependency chain complexity and just insert.
         await new Promise((resolve, reject) => {
             con.run(`INSERT INTO user_categories (user_id, name, is_adult, sort_order) VALUES (${userId}, '${provCat.category_name}', 0, 0)`, (err) => {
                 if(err) reject(err); else resolve();
             });
         });
    }

    // Process Channels
    // Using the prepared statement
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        await new Promise((resolve, reject) => {
            insertChannelStmt.run(
                providerId,
                Number(ch.stream_id),
                ch.name,
                Number(ch.category_id),
                ch.stream_icon,
                'live',
                ch.epg_channel_id,
                i,
                (err) => { if (err) reject(err); else resolve(); }
            );
        });
    }

    await run('COMMIT');

    const end = process.hrtime(start);
    const timeInMs = (end[0] * 1000 + end[1] / 1e6).toFixed(2);
    const recordsPerSec = (channels.length / (timeInMs / 1000)).toFixed(0);

    console.log(`Finished DuckDB: ${timeInMs}ms`);
    console.log(`Throughput: ${recordsPerSec} records/sec`);

    // Clean up
    insertChannelStmt.finalize();
}

main().catch(console.error);
