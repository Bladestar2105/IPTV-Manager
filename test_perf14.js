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
            plot: "Plot...",
            cast: "Cast...",
            director: "Director...",
            genre: "Genre...",
            releaseDate: "2020",
            rating: "5.0",
            episode_run_time: "60"
        }));
    }
})();

console.time('current xtream controller - array parse in Node');
for (let i = 0; i < 100; i++) {
   const rows = db.prepare(`
       SELECT
           json_extract(metadata, '$.backdrop_path') as backdrop_path
       FROM test`).all();
   const mapped = rows.map(r => {
        let backdrop_path = [];
        if (r.backdrop_path) {
             try {
                 const parsed = JSON.parse(r.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch(e){}
        }
       return {
           backdrop_path: backdrop_path
       };
   });
}
console.timeEnd('current xtream controller - array parse in Node');

console.time('xtream controller using direct SQLite JSON object extraction');
for (let i = 0; i < 100; i++) {
   // Instead of extracting a JSON string array to Node and calling JSON.parse in a loop,
   // what if we just didn't parse it in get_series and just returned the raw string if it's an array
   // ... wait, the API response `backdrop_path` needs to be an array in JSON response.
   // But we can just pass the string to res.json somehow? No res.json needs object.
   // Wait, what if we use json() built-in SQLite to return a valid JSON object
   // No better-sqlite3 doesn't automatically parse json().
   const rows = db.prepare(`
       SELECT
           json_extract(metadata, '$.backdrop_path') as backdrop_path
       FROM test`).all();
   const mapped = rows.map(r => {
        let backdrop_path = [];
        if (r.backdrop_path) {
             try {
                 const parsed = JSON.parse(r.backdrop_path);
                 if (Array.isArray(parsed)) backdrop_path = parsed;
             } catch(e){}
        }
       return {
           backdrop_path: backdrop_path
       };
   });
}
console.timeEnd('xtream controller using direct SQLite JSON object extraction');
