import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (metadata TEXT);
`);

const stmt = db.prepare('INSERT INTO test (metadata) VALUES (?)');
db.transaction(() => {
    for (let i = 0; i < 50000; i++) {
        stmt.run(JSON.stringify({
           drm: { license_type: "widevine", license_key: "key" },
           backdrop_path: ["url1", "url2"],
           plot: "A plot",
           cast: "A cast",
           director: "Director",
           genre: "Genre",
           releaseDate: "2020",
           rating: "5.0",
           episode_run_time: "60"
        }));
    }
})();

console.time('xtream controller current DB selection logic');
for (let i = 0; i < 10; i++) {
   const rows = db.prepare(`
       SELECT
        json_extract(metadata, '$.drm.license_type') as drm_license_type,
        json_extract(metadata, '$.drm.license_key') as drm_license_key
       FROM test`).all();

   const mapped = rows.map(ch => {
      let drm = undefined;
      if (ch.drm_license_type || ch.drm_license_key) {
          drm = {};
          if (ch.drm_license_type) drm.license_type = ch.drm_license_type;
          if (ch.drm_license_key) drm.license_key = ch.drm_license_key;
      }
      return drm;
   });
}
console.timeEnd('xtream controller current DB selection logic');


console.time('fetch full metadata instead');
for (let i = 0; i < 10; i++) {
   const rows = db.prepare(`SELECT metadata FROM test`).all();

   const mapped = rows.map(ch => {
      let drm = undefined;
      if (ch.metadata) {
          try {
             const m = JSON.parse(ch.metadata);
             if (m.drm) {
                 drm = {};
                 if (m.drm.license_type) drm.license_type = m.drm.license_type;
                 if (m.drm.license_key) drm.license_key = m.drm.license_key;
             }
          } catch(e) {}
      }
      return drm;
   });
}
console.timeEnd('fetch full metadata instead');
