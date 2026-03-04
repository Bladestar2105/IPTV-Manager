const db = require('better-sqlite3')('memory.db');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, backdrop_path TEXT);
INSERT INTO test (backdrop_path) VALUES ('["url1", "url2"]');
INSERT INTO test (backdrop_path) VALUES ('[]');
INSERT INTO test (backdrop_path) VALUES (NULL);
`);

console.time('native');
for (let i = 0; i < 10000; i++) {
   const rows = db.prepare(`SELECT backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = [];
       if (r.backdrop_path) {
           try { parsed = JSON.parse(r.backdrop_path); } catch(e) {}
       }
       return { path: parsed };
   });
}
console.timeEnd('native');
