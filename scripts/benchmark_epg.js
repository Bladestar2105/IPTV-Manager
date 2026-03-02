import Database from 'better-sqlite3';

const db = new Database(':memory:');

db.exec(`
    CREATE TABLE epg_programs (
        channel_id TEXT NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER NOT NULL,
        title TEXT,
        desc TEXT
    );
`);

// Insert 1000 channels, each with 50 programs (50,000 total)
const insert = db.prepare('INSERT INTO epg_programs (channel_id, start, stop, title, desc) VALUES (?, ?, ?, ?, ?)');
db.transaction(() => {
    for (let c = 1; c <= 1000; c++) {
        for (let p = 1; p <= 50; p++) {
            insert.run(`ch_${c}`, 100 + p, 200 + p, `Program ${p} on Channel ${c}`, `Description for program ${p}`);
        }
    }
})();

const OLD_QUERY = `
    SELECT channel_id, title, desc, start, stop
    FROM epg_programs
    WHERE stop >= ? AND start <= ?
    ORDER BY start ASC
`;

const NEW_QUERY = `
    SELECT channel_id, json_group_array(
        json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)
    ) as programs
    FROM (
        SELECT * FROM epg_programs
        WHERE stop >= ? AND start <= ?
        ORDER BY start ASC
    )
    GROUP BY channel_id
`;

const stmtOld = db.prepare(OLD_QUERY);
const stmtNew = db.prepare(NEW_QUERY);

const ITERATIONS = 100;

console.log("Benchmarking OLD approach (JS Aggregation)...");
const startOld = process.hrtime.bigint();
let memOldStart = process.memoryUsage().heapUsed;

for (let i = 0; i < ITERATIONS; i++) {
    const programs = stmtOld.all(0, 1000000);
    const schedule = {};
    for (const prog of programs) {
        if (!schedule[prog.channel_id]) schedule[prog.channel_id] = [];
        schedule[prog.channel_id].push({
          start: prog.start,
          stop: prog.stop,
          title: prog.title,
          desc: prog.desc || ''
        });
    }
}
let memOldEnd = process.memoryUsage().heapUsed;
const endOld = process.hrtime.bigint();
const timeOld = Number(endOld - startOld) / 1000000;
console.log(`OLD Approach Time: ${timeOld.toFixed(2)}ms`);
console.log(`OLD Approach Memory Delta: ${((memOldEnd - memOldStart) / 1024 / 1024).toFixed(2)} MB\n`);

console.log("Benchmarking NEW approach (SQLite JSON Aggregation)...");
const startNew = process.hrtime.bigint();
let memNewStart = process.memoryUsage().heapUsed;

for (let i = 0; i < ITERATIONS; i++) {
    const programs = stmtNew.all(0, 1000000);
    const schedule = {};
    for (const prog of programs) {
        try {
            schedule[prog.channel_id] = JSON.parse(prog.programs);
        } catch (e) {
            schedule[prog.channel_id] = [];
        }
    }
}
let memNewEnd = process.memoryUsage().heapUsed;
const endNew = process.hrtime.bigint();
const timeNew = Number(endNew - startNew) / 1000000;
console.log(`NEW Approach Time: ${timeNew.toFixed(2)}ms`);
console.log(`NEW Approach Memory Delta: ${((memNewEnd - memNewStart) / 1024 / 1024).toFixed(2)} MB\n`);
