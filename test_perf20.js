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

console.time('JSON.parse array loop JS');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       let backdrop_path = [];
       if (r.backdrop_path) {
             try {
                 const parsed = JSON.parse(r.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch(e){}
       }
       return { backdrop_path: backdrop_path };
   });
}
console.timeEnd('JSON.parse array loop JS');
