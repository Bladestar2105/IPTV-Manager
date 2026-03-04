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
        json_extract(metadata, '$.backdrop_path') as backdrop_path
       FROM test`).all();

   const mapped = rows.map(ch => {
        let backdrop_path = [];
        if (ch.backdrop_path) {
             try {
                 const parsed = JSON.parse(ch.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch(e){}
        }
        return backdrop_path;
   });
}
console.timeEnd('xtream controller current DB selection logic');
