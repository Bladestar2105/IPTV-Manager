import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, metadata TEXT);
`);

const stmt = db.prepare('INSERT INTO test (metadata) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run(JSON.stringify({ drm: { license_type: "widevine", license_key: "key" } }));
    }
})();

console.time('json_extract separated');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
        SELECT
           json_extract(metadata, '$.drm.license_type') as drm_license_type,
           json_extract(metadata, '$.drm.license_key') as drm_license_key
        FROM test
   `).all();
   const mapped = rows.map(r => {
       return { type: r.drm_license_type, key: r.drm_license_key };
   });
}
console.timeEnd('json_extract separated');

console.time('json_extract object then parsed in Node.js');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
        SELECT
           json_extract(metadata, '$.drm') as drm
        FROM test
   `).all();
   const mapped = rows.map(r => {
       let drm = null;
       if (r.drm) {
           drm = JSON.parse(r.drm);
       }
       return { type: drm?.license_type, key: drm?.license_key };
   });
}
console.timeEnd('json_extract object then parsed in Node.js');

console.time('json_extract object then parsed in Node.js (with check)');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
        SELECT
           json_extract(metadata, '$.drm') as drm
        FROM test
   `).all();
   const mapped = rows.map(r => {
       let type = null, key = null;
       if (r.drm) {
           const drm = JSON.parse(r.drm);
           type = drm.license_type;
           key = drm.license_key;
       }
       return { type, key };
   });
}
console.timeEnd('json_extract object then parsed in Node.js (with check)');
