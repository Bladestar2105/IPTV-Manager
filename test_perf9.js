import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, metadata TEXT);
`);

const stmt = db.prepare('INSERT INTO test (metadata) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run(JSON.stringify({ backdrop_path: ["url1", "url2"] }));
    }
})();

console.time('parse each iteration object');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT metadata FROM test`).all();
   const mapped = rows.map(r => {
       try { return JSON.parse(r.metadata).backdrop_path; } catch(e) { return [] }
   });
}
console.timeEnd('parse each iteration object');

console.time('json_extract string');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       try { return JSON.parse(r.backdrop_path); } catch(e) { return [] }
   });
}
console.timeEnd('json_extract string');
