import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE epg_programs (channel_id INTEGER, title TEXT, "desc" TEXT, start INTEGER, stop INTEGER);
`);

const stmt = db.prepare('INSERT INTO epg_programs (channel_id, title, "desc", start, stop) VALUES (?, ?, ?, ?, ?)');
db.transaction(() => {
    for (let i = 0; i < 50000; i++) {
        stmt.run(i % 1000, "News", "Local news", 16000000 + i, 16000100 + i);
    }
})();

console.time('current getProgramsSchedule JSON.parse loop in controller');
for (let i = 0; i < 10; i++) {
    const programs = db.prepare(`
        SELECT channel_id, json_group_array(
            json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)
        ) as programs
        FROM (
            SELECT * FROM epg_programs
            WHERE stop >= ? AND start <= ?
            ORDER BY start ASC
        )
        GROUP BY channel_id
    `).all(16000000, 16050000);
    const schedule = {};
    for (const prog of programs) {
        try {
            schedule[prog.channel_id] = JSON.parse(prog.programs);
        } catch (e) {
            schedule[prog.channel_id] = [];
        }
    }
}
console.timeEnd('current getProgramsSchedule JSON.parse loop in controller');

console.time('json_group_object wrapper directly');
for (let i = 0; i < 10; i++) {
    const row = db.prepare(`
        SELECT json_group_object(
            channel_id,
            json(programs)
        ) as schedule
        FROM (
            SELECT channel_id, json_group_array(
                json_object('title', title, 'desc', IFNULL(desc, ''), 'start', start, 'stop', stop)
            ) as programs
            FROM (
                SELECT * FROM epg_programs
                WHERE stop >= ? AND start <= ?
                ORDER BY start ASC
            )
            GROUP BY channel_id
        )
    `).get(16000000, 16050000);
    const schedule = row.schedule ? JSON.parse(row.schedule) : {};
}
console.timeEnd('json_group_object wrapper directly');
