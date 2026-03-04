import Database from 'better-sqlite3';

const db = new Database('memory.db');
db.exec(`
CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, backdrop_path TEXT);
DELETE FROM test;
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

console.time('sqlite_json');
for (let i = 0; i < 10000; i++) {
   // return parsed JSON tree direct? No better-sqlite returns string from json_extract usually
   const rows = db.prepare(`SELECT json_extract(backdrop_path, '$') as parsed FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = [];
       if (r.parsed) {
           try { parsed = JSON.parse(r.parsed); } catch(e) {}
       }
       return { path: parsed };
   });
}
console.timeEnd('sqlite_json');
