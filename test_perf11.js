import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, metadata TEXT);
`);

const stmt = db.prepare('INSERT INTO test (metadata) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run(JSON.stringify({
            drm: { license_type: "widevine", license_key: "key" },
            backdrop_path: ["url1", "url2"],
        }));
    }
})();

console.time('json_extract all explicitly');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
       SELECT
           json_extract(metadata, '$.drm.license_type') as drm_license_type,
           json_extract(metadata, '$.drm.license_key') as drm_license_key,
           json_extract(metadata, '$.backdrop_path') as backdrop_path
       FROM test`).all();
   const mapped = rows.map(r => {
       return {
           drm_license_type: r.drm_license_type,
           drm_license_key: r.drm_license_key,
           backdrop_path: r.backdrop_path ? JSON.parse(r.backdrop_path) : []
       };
   });
}
console.timeEnd('json_extract all explicitly');

console.time('js json parse metadata directly');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`SELECT metadata FROM test`).all();
   const mapped = rows.map(r => {
       let parsed = {};
       try { parsed = JSON.parse(r.metadata); } catch(e) {}
       return {
           drm_license_type: parsed.drm?.license_type,
           drm_license_key: parsed.drm?.license_key,
           backdrop_path: parsed.backdrop_path || []
       };
   });
}
console.timeEnd('js json parse metadata directly');
