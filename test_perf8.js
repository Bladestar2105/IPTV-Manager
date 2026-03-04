import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, metadata TEXT);
`);

const stmt = db.prepare('INSERT INTO test (metadata) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run(JSON.stringify({ plot: "A plot", cast: "A cast", director: "Director", genre: "Genre", releaseDate: "2020", rating: "5.0", episode_run_time: "60" }));
    }
})();

console.time('json_extract string individual + parse fallback');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT * FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = {};
       try { parsed = JSON.parse(r.metadata); } catch(e) {}
       return { plot: parsed.plot, cast: parsed.cast, director: parsed.director, genre: parsed.genre };
   });
}
console.timeEnd('json_extract string individual + parse fallback');

console.time('json_extract explicit sqlite extraction');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
       SELECT
           json_extract(metadata, '$.plot') as plot,
           json_extract(metadata, '$.cast') as "cast",
           json_extract(metadata, '$.director') as director,
           json_extract(metadata, '$.genre') as genre
       FROM test`).all();
   const mapped = rows.map(r => {
       return { plot: r.plot, cast: r.cast, director: r.director, genre: r.genre };
   });
}
console.timeEnd('json_extract explicit sqlite extraction');
