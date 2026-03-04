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

console.time('json_extract string');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       return r.backdrop_path;
   });
}
console.timeEnd('json_extract string');

console.time('json_extract string + JSON.parse');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as backdrop_path FROM test`).all();
   const mapped = rows.map(r => {
       return r.backdrop_path ? JSON.parse(r.backdrop_path) : [];
   });
}
console.timeEnd('json_extract string + JSON.parse');

console.time('json_group_array direct sqlite');
for (let i = 0; i < 100; i++) {
   const row = db.prepare(`
        SELECT json_group_array(json_extract(metadata, '$.backdrop_path')) as array
        FROM test
   `).get();
   const parsedArray = JSON.parse(row.array);
   const mapped = parsedArray.map(item => {
      return typeof item === 'string' ? JSON.parse(item) : item;
   });
}
console.timeEnd('json_group_array direct sqlite');
