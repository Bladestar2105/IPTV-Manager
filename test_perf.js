const db = require('better-sqlite3')('memory.db');
db.exec(`
CREATE TABLE test (id INTEGER PRIMARY KEY, metadata TEXT);
INSERT INTO test (metadata) VALUES ('{"backdrop_path": ["url1", "url2"]}');
INSERT INTO test (metadata) VALUES ('{"backdrop_path": []}');
INSERT INTO test (metadata) VALUES ('{}');
INSERT INTO test (metadata) VALUES (NULL);
`);
const result1 = db.prepare(`SELECT json_extract(metadata, '$.backdrop_path') as path FROM test`).all();
console.log(result1);
