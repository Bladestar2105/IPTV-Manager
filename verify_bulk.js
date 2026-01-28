import fetch from 'node-fetch';
import Database from 'better-sqlite3';

const db = new Database('db.sqlite');
const PORT = 3000;

async function run() {
  try {
    // 1. Inject Provider and Channels directly
    const pid = db.prepare("INSERT INTO providers (name, url, username, password, user_id) VALUES ('TestProv', 'http://t', 'u', 'p', 1)").run().lastInsertRowid;
    // Insert User 1 (Admin is in admin_users, but providers need user_id link usually to users table?
    // Wait, providers table has user_id which links to users table. Admin users are separate.
    // I need to create a regular user first.

    // Login as Admin
    const loginRes = await fetch(`http://localhost:${PORT}/api/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'admin', password: 'secret'})
    });
    const loginData = await loginRes.json();
    const token = loginData.token;

    // Create User
    const userRes = await fetch(`http://localhost:${PORT}/api/users`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({username: 'testuser', password: 'password123'})
    });
    const userData = await userRes.json();
    const userId = userData.id;

    // Update provider to belong to this user
    db.prepare('UPDATE providers SET user_id = ? WHERE id = ?').run(userId, pid);

    // Insert channels: B (order 1), A (order 2)
    db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, original_sort_order) VALUES (?, 101, 'Channel A', 1, 2)").run(pid);
    db.prepare("INSERT INTO provider_channels (provider_id, remote_stream_id, name, original_category_id, original_sort_order) VALUES (?, 102, 'Channel B', 1, 1)").run(pid);

    console.log('Testing Bulk Import...');
    const importRes = await fetch(`http://localhost:${PORT}/api/providers/${pid}/import-categories`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify({
            user_id: userId,
            categories: [
                {id: 1, name: 'Cat 1', import_channels: true}
            ]
        })
    });

    const importData = await importRes.json();
    console.log('Import Result:', JSON.stringify(importData, null, 2));

    if (!importData.success) process.exit(1);

    // Verify Order in DB
    const userChans = db.prepare(`
        SELECT pc.name
        FROM user_channels uc
        JOIN provider_channels pc ON pc.id = uc.provider_channel_id
        JOIN user_categories cat ON cat.id = uc.user_category_id
        WHERE cat.user_id = ?
        ORDER BY uc.sort_order
    `).all(userId);

    console.log('User Channels Order:', userChans.map(c => c.name));

    if (userChans[0].name === 'Channel B' && userChans[1].name === 'Channel A') {
        console.log('✅ Order Correct!');
    } else {
        console.error('❌ Order Incorrect!');
        process.exit(1);
    }

  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
