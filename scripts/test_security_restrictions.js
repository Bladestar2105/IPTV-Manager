
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const PORT = 3004;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = './test_data_security_2';

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

  // Wait for server to start
  console.log('Waiting for server...');
  for (let i = 0; i < 30; i++) {
      try {
          // Check if port is open by making a request
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
    // Kill workers if possible?
    try { process.kill(-serverProcess.pid); } catch(e){}
  }
  // Cleanup
  // fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

async function runTests() {
  console.log('🚀 Starting Security Restrictions Tests...');
  try {
    await startServer();

    // 1. Login as Admin
    console.log('🔹 Login Admin...');
    let res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'admin', password: 'adminpass'})
    });
    let data = await res.json();
    const adminToken = data.token;
    if (!adminToken) throw new Error('Admin login failed: ' + JSON.stringify(data));
    console.log('✅ Admin logged in');

    // 2. Create Normal User (WebUI Enabled)
    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'user1', password: 'password123', webui_access: true})
    });
    if (!res.ok) throw new Error('Failed to create user1');
    data = await res.json();
    const userId1 = data.id;
    console.log('✅ Created User 1 (WebUI Enabled)');

    // 3. Create Normal User (WebUI Disabled)
    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'user2', password: 'password123', webui_access: false})
    });
    if (!res.ok) throw new Error('Failed to create user2');
    data = await res.json();
    const userId2 = data.id;
    console.log('✅ Created User 2 (WebUI Disabled)');

    // 4. Test User 1 Login (Should Succeed)
    res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'user1', password: 'password123'})
    });
    if (res.status !== 200) throw new Error(`User 1 Login Failed: ${res.status}`);
    data = await res.json();
    const userToken = data.token;
    console.log('✅ User 1 Login Successful');

    // 5. Test User 2 Login (Should Fail)
    res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'user2', password: 'password123'})
    });
    if (res.status !== 403) throw new Error(`User 2 Login Should be 403, got ${res.status}`);
    console.log('✅ User 2 Login Blocked (403)');

    // 6. Test Admin Only Endpoints with User Token
    const adminEndpoints = [
        { method: 'GET', url: '/api/epg-sources' },
        { method: 'GET', url: '/api/statistics' },
        { method: 'GET', url: '/api/security/logs' },
        { method: 'GET', url: '/api/export?user_id=all&password=123' },
        { method: 'POST', url: '/api/providers/1/sync', body: {user_id: userId1} } // Provider 1 won't exist but we check 403 before 404/500
    ];

    for (const ep of adminEndpoints) {
        const opts = {
            method: ep.method,
            headers: {'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json'}
        };
        if (ep.body) opts.body = JSON.stringify(ep.body);

        res = await fetch(`${BASE_URL}${ep.url}`, opts);

        // Note: For sync, if provider doesn't exist, it might error differently if logic checks existence before perm?
        // Let's see src/server.js: provider check happens first?
        // app.post('/api/providers/:id/sync' ... checks perm FIRST. Good.

        if (res.status !== 403) {
            throw new Error(`User was able to access ${ep.method} ${ep.url} (Status: ${res.status})`);
        }
        console.log(`✅ User blocked from ${ep.url}`);
    }

    console.log('🎉 All Security Tests Passed!');

  } catch (e) {
    console.error('❌ Test Failed:', e);
    process.exit(1);
  } finally {
    await stopServer();
  }
}

runTests();
