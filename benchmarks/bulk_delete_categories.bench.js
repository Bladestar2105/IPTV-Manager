
import Database from 'better-sqlite3';
import { performance } from 'perf_hooks';

const db = new Database(':memory:');

// Setup schema
db.exec(`
    CREATE TABLE user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_adult INTEGER DEFAULT 0,
      type TEXT DEFAULT 'live'
    );

    CREATE TABLE user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE category_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider_category_id INTEGER NOT NULL,
      provider_category_name TEXT NOT NULL,
      user_category_id INTEGER,
      auto_created INTEGER DEFAULT 0
    );
`);

function populate(count) {
    db.prepare('DELETE FROM user_channels').run();
    db.prepare('DELETE FROM category_mappings').run();
    db.prepare('DELETE FROM user_categories').run();

    const insertCat = db.prepare('INSERT INTO user_categories (user_id, name) VALUES (?, ?)');
    const insertChan = db.prepare('INSERT INTO user_channels (user_category_id, provider_channel_id) VALUES (?, ?)');
    const insertMap = db.prepare('INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id) VALUES (?, ?, ?, ?, ?)');

    const ids = [];
    for (let i = 0; i < count; i++) {
        const info = insertCat.run(1, `Category ${i}`);
        const catId = info.lastInsertRowid;
        ids.push(Number(catId));

        for (let j = 0; j < 10; j++) {
            insertChan.run(catId, j);
        }
        insertMap.run(1, 1, i, `Provider Cat ${i}`, catId);
    }
    return ids;
}

function originalBulkDelete(ids, user) {
    db.transaction(() => {
      for (const id of ids) {
         if (!user.is_admin) {
             const cat = db.prepare('SELECT user_id FROM user_categories WHERE id = ?').get(id);
             if (!cat || cat.user_id !== user.id) throw new Error('Access denied');
         }
         db.prepare('DELETE FROM user_channels WHERE user_category_id = ?').run(id);
         db.prepare('UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id = ?').run(id);
         db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
      }
    })();
}

function optimizedBulkDelete(ids, user) {
    db.transaction(() => {
      if (!user.is_admin) {
         const placeholders = ids.map(() => '?').join(',');
         const cats = db.prepare(`SELECT id, user_id FROM user_categories WHERE id IN (${placeholders})`).all(...ids);
         if (cats.length !== ids.length) throw new Error('Access denied');
         for (const cat of cats) {
             if (cat.user_id !== user.id) throw new Error('Access denied');
         }
      }

      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM user_channels WHERE user_category_id IN (${placeholders})`).run(...ids);
      db.prepare(`UPDATE category_mappings SET user_category_id = NULL, auto_created = 0 WHERE user_category_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM user_categories WHERE id IN (${placeholders})`).run(...ids);
    })();
}

const count = 100;
const user = { id: 1, is_admin: false };

console.log(`Benchmarking with ${count} categories...`);

// Original
let ids = populate(count);
let start = performance.now();
originalBulkDelete(ids, user);
let end = performance.now();
const originalTime = end - start;
console.log(`Original: ${originalTime.toFixed(4)}ms`);

// Optimized
ids = populate(count);
start = performance.now();
optimizedBulkDelete(ids, user);
end = performance.now();
const optimizedTime = end - start;
console.log(`Optimized: ${optimizedTime.toFixed(4)}ms`);

console.log(`Improvement: ${((originalTime - optimizedTime) / originalTime * 100).toFixed(2)}%`);
