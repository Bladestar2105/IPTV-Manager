import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec(`
CREATE TABLE test (channel_name TEXT, ip TEXT, provider_id INTEGER, user_id INTEGER);
`);

const stmt = db.prepare('INSERT INTO test (channel_name, ip, provider_id, user_id) VALUES (?, ?, ?, ?)');
db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
        stmt.run("Chan_" + (i % 100), "192.168.1." + (i % 10), i % 5, i % 3);
    }
})();

console.time('current getUserConnectionCount JS');
for (let i = 0; i < 1000; i++) {
    const all = db.prepare('SELECT * FROM test').all();
    const userStreams = all.filter(s => s.user_id === 1);
    const uniqueSessions = new Set(userStreams.map(s =>
        `${s.channel_name}|${s.ip}|${s.provider_id}`
    ));
    const size = uniqueSessions.size;
}
console.timeEnd('current getUserConnectionCount JS');

console.time('sqlite count filter DB');
for (let i = 0; i < 1000; i++) {
   const res = db.prepare('SELECT COUNT(*) as count FROM (SELECT DISTINCT channel_name, ip, provider_id FROM test WHERE user_id = ?)').get(1);
   const size = res.count;
}
console.timeEnd('sqlite count filter DB');
