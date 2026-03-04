import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE epg_programs (channel_id INTEGER, title TEXT, "desc" TEXT, start INTEGER, stop INTEGER);
`);

const stmt = db.prepare('INSERT INTO epg_programs (channel_id, title, "desc", start, stop) VALUES (?, ?, ?, ?, ?)');
db.transaction(() => {
    for (let i = 0; i < 50000; i++) {
        stmt.run(i, "News", "Local news", 16000000, 16000100);
    }
})();

console.time('current grouping JS');
for (let i = 0; i < 10; i++) {
    const programs = db.prepare(`
        SELECT channel_id, json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop) as program
        FROM epg_programs
        GROUP BY channel_id
    `).all();
   const currentPrograms = {};
   for (const prog of programs) {
        try {
            currentPrograms[prog.channel_id] = JSON.parse(prog.program);
        } catch (e) {}
   }
}
console.timeEnd('current grouping JS');

console.time('full grouping SQLite');
for (let i = 0; i < 10; i++) {
    const row = db.prepare(`
        SELECT json_group_object(channel_id, json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)) as json_data
        FROM epg_programs
        GROUP BY channel_id
    `).get();
    // note: with GROUP BY channel_id, json_group_object makes an object of 1 key, then we have many rows...
    // without group by, we get one big object!
}
console.timeEnd('full grouping SQLite');

console.time('full grouping SQLite NO GROUP BY');
for (let i = 0; i < 10; i++) {
    const row = db.prepare(`
        SELECT json_group_object(channel_id, json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)) as json_data
        FROM (SELECT channel_id, title, desc, start, stop FROM epg_programs GROUP BY channel_id)
    `).get();
    const currentPrograms = JSON.parse(row.json_data);
}
console.timeEnd('full grouping SQLite NO GROUP BY');
