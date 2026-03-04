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

console.time('json_extract separated parse in js loop');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = [];
       if (r.backdrop_path) {
           try { parsed = JSON.parse(r.backdrop_path); } catch(e) {}
       }
       return { backdrop_path: parsed };
   });
}
console.timeEnd('json_extract separated parse in js loop');

console.time('json_extract string replace js loop');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
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
console.timeEnd('json_extract string replace js loop');
