import Database from 'better-sqlite3';

const db = new Database(':memory:');

// Replicate schema relevant to the optimization
db.exec(`
  CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_adult INTEGER DEFAULT 0,
      type TEXT DEFAULT 'live'
    );

    CREATE TABLE IF NOT EXISTS user_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_category_id INTEGER NOT NULL,
      provider_channel_id INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS provider_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
`);

console.log("⚡ Bolt Performance Verification: DB Indexes");
console.log("===========================================");

function checkPlan(query, params, description) {
  console.log(`\n🔍 Checking: ${description}`);
  console.log(`   Query: ${query}`);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(params);

  let scanCount = 0;
  let searchCount = 0;
  let useIndexCount = 0;

  plan.forEach(row => {
    console.log(`   Plan: ${row.detail}`);
    if (row.detail.includes('SCAN')) scanCount++;
    if (row.detail.includes('SEARCH')) searchCount++;
    if (row.detail.includes('USING INDEX')) useIndexCount++;
  });

  return { scanCount, searchCount, useIndexCount };
}

// 1. BEFORE Optimization
console.log("\n--- [BEFORE] Missing Indexes ---");

checkPlan(
  'SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order',
  [1],
  'Get User Categories (Filter by user + Sort)'
);

checkPlan(
  'SELECT * FROM user_channels WHERE user_category_id = ? ORDER BY sort_order',
  [1],
  'Get Category Channels (Filter by category + Sort)'
);

checkPlan(
  `SELECT uc.id, pc.name
   FROM user_channels uc
   JOIN provider_channels pc ON pc.id = uc.provider_channel_id
   WHERE uc.user_category_id = ?`,
  [1],
  'Join User Channels with Provider Channels'
);


// 2. APPLY Optimization
console.log("\n\n🛠️  Applying Optimization (Adding Indexes)...");

db.exec('CREATE INDEX IF NOT EXISTS idx_user_categories_user_sort ON user_categories(user_id, sort_order)');
db.exec('CREATE INDEX IF NOT EXISTS idx_user_channels_cat_sort ON user_channels(user_category_id, sort_order)');
db.exec('CREATE INDEX IF NOT EXISTS idx_user_channels_prov ON user_channels(provider_channel_id)');

console.log("✅ Indexes Created");


// 3. AFTER Optimization
console.log("\n--- [AFTER] With Indexes ---");

const res1 = checkPlan(
  'SELECT * FROM user_categories WHERE user_id = ? ORDER BY sort_order',
  [1],
  'Get User Categories (Filter by user + Sort)'
);

const res2 = checkPlan(
  'SELECT * FROM user_channels WHERE user_category_id = ? ORDER BY sort_order',
  [1],
  'Get Category Channels (Filter by category + Sort)'
);

const res3 = checkPlan(
  `SELECT uc.id, pc.name
   FROM user_channels uc
   JOIN provider_channels pc ON pc.id = uc.provider_channel_id
   WHERE uc.user_category_id = ?`,
  [1],
  'Join User Channels with Provider Channels'
);

// Summary
console.log("\n===========================================");
if (res1.searchCount > 0 && res2.searchCount > 0) {
  console.log("✅ SUCCESS: Query plans now use SEARCH instead of SCAN.");
} else {
  console.log("❌ FAILURE: Optimization did not result in SEARCH plans.");
  process.exit(1);
}
