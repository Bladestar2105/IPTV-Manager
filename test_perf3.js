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

console.time('json_extract + parse in js');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = [];
       if (r.backdrop_path) {
           try { parsed = JSON.parse(r.backdrop_path); } catch(e) {}
       }
       return { path: parsed };
   });
}
console.timeEnd('json_extract + parse in js');

console.time('json_group_array direct in sqlite (subquery)');
for (let i = 0; i < 100; i++) {
   const row = db.prepare(`
        SELECT json_group_array(json_extract(metadata, '$.backdrop_path')) as array
        FROM test
   `).get();
   const parsedArray = JSON.parse(row.array);
   const mapped = parsedArray.map(item => {
      let parsed = [];
      if (typeof item === 'string') {
           try { parsed = JSON.parse(item); } catch(e) {}
      } else {
           parsed = item; // sqlite might have already done it
      }
      return { path: parsed };
   });
}
console.timeEnd('json_group_array direct in sqlite (subquery)');
