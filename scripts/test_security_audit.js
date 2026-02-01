
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = 3008;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = './test_data_security_audit';

let serverProcess;

async function startServer() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR);

  const env = {
      ...process.env,
      PORT,
      DATA_DIR,
      INITIAL_ADMIN_PASSWORD: 'adminpass'
  };

  serverProcess = spawn('node', ['src/server.js'], { env, stdio: 'pipe' });

  // Wait for server
  for (let i = 0; i < 30; i++) {
      try {
          await fetch(`${BASE_URL}/api/login`, { method: 'OPTIONS' });
          console.log('Server is up!');
          return;
      } catch (e) {
          await new Promise(r => setTimeout(r, 1000));
      }
  }
  throw new Error('Server failed to start');
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    try { process.kill(-serverProcess.pid); } catch(e){}
  }
}

async function runTests() {
  console.log('🚀 Starting Security Audit...');
  try {
    await startServer();

    // 1. Setup: Admin + 2 Users
    console.log('🔹 Setup...');
    let res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'admin', password: 'adminpass'})
    });
    const adminToken = (await res.json()).token;

    // User 1
    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'user1', password: 'password123'})
    });
    const user1Id = (await res.json()).id;

    // User 2
    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'user2', password: 'password123'})
    });
    const user2Id = (await res.json()).id;

    // Login as User 1
    res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'user1', password: 'password123'})
    });
    const user1Token = (await res.json()).token;

    // 2. Test: IDOR on Categories
    // User 1 tries to fetch User 2's categories
    console.log('🔹 Testing IDOR on Categories...');
    res = await fetch(`${BASE_URL}/api/users/${user2Id}/categories`, {
        headers: {'Authorization': `Bearer ${user1Token}`}
    });
    if (res.status !== 403) {
        throw new Error(`IDOR Failed: User 1 could access User 2 categories! Status: ${res.status}`);
    }
    console.log('✅ User 1 blocked from User 2 categories (403)');

    // 3. Test: IDOR on Category Channels
    // First, admin creates a category for User 2
    res = await fetch(`${BASE_URL}/api/users/${user2Id}/categories`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({name: 'User2 Cat'})
    });
    const user2CatId = (await res.json()).id;

    // User 1 tries to access channels of User 2's category
    console.log('🔹 Testing IDOR on Category Channels...');
    res = await fetch(`${BASE_URL}/api/user-categories/${user2CatId}/channels`, {
        headers: {'Authorization': `Bearer ${user1Token}`}
    });
    if (res.status !== 403) {
        throw new Error(`IDOR Failed: User 1 could access User 2 category channels! Status: ${res.status}`);
    }
    console.log('✅ User 1 blocked from User 2 category channels (403)');

    console.log('🎉 Security Audit Passed!');

  } catch (e) {
    console.error('❌ Test Failed:', e);
    process.exit(1);
  } finally {
    await stopServer();
  }
}

runTests();
