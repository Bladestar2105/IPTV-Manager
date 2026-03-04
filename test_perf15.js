import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE epg_programs (channel_id INTEGER, program TEXT);
`);

const stmt = db.prepare('INSERT INTO epg_programs (channel_id, program) VALUES (?, ?)');
db.transaction(() => {
    for (let i = 0; i < 50000; i++) {
        stmt.run(i, JSON.stringify({
             title: "News", desc: "Local news", start: 16000000, stop: 16000100
        }));
    }
})();

console.time('current JSON.parse in loop');
for (let i = 0; i < 10; i++) {
   const programs = db.prepare('SELECT channel_id, program FROM epg_programs').all();
   const currentPrograms = {};
   for (const prog of programs) {
        try {
            currentPrograms[prog.channel_id] = JSON.parse(prog.program);
        } catch (e) {
        }
    }
}
console.timeEnd('current JSON.parse in loop');

console.time('sqlite json_group_object');
for (let i = 0; i < 10; i++) {
    const row = db.prepare(`
        SELECT json_group_object(channel_id, json(program)) as json_data
        FROM epg_programs
    `).get();
    const currentPrograms = JSON.parse(row.json_data);
}
console.timeEnd('sqlite json_group_object');
