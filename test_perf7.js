import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, backdrop_path TEXT);
`);

const stmt = db.prepare('INSERT INTO test (backdrop_path) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run(JSON.stringify(["url1", "url2"]));
    }
})();

console.time('json_extract string');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(backdrop_path, '$') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       return r.backdrop_path;
   });
}
console.timeEnd('json_extract string');

console.time('sqlite json native object extraction');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       return r.backdrop_path ? JSON.parse(r.backdrop_path) : [];
   });
}
console.timeEnd('sqlite json native object extraction');
