import Database from 'better-sqlite3';
const db = new Database('db.sqlite');
console.log('Checking provider_channels...');
const pc = db.prepare("PRAGMA table_info(provider_channels)").all();
console.log(pc.map(c => c.name));

console.log('Checking stream_stats...');
try {
  const ss = db.prepare("PRAGMA table_info(stream_stats)").all();
  console.log(ss.map(c => c.name));
} catch(e) { console.log('stream_stats missing'); }
