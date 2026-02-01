
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import fetch from 'node-fetch';

const PORT = 3005;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = './test_data_frontend';

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

async function run() {
  try {
    await startServer();

    // Create User via API first (Admin Token needed)
    // Login Admin
    let res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'admin', password: 'adminpass'})
    });
    let data = await res.json();
    const adminToken = data.token;

    // Create User
    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'testuser', password: 'password123'})
    });
    if (!res.ok) throw new Error('Failed to create user');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // 1. Admin Login & Screenshot
    console.log('📸 Admin View...');
    await page.goto(BASE_URL);
    // Fill login
    await page.waitForSelector('#login-username'); // Wait for modal
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'adminpass');
    await page.click('#login-btn');

    await page.waitForSelector('#nav-dashboard'); // Wait for login success
    await page.waitForTimeout(1000); // Wait for UI update

    // Check elements visibility
    const statsVisible = await page.isVisible('#nav-statistics');
    console.log('Admin sees Statistics:', statsVisible); // Should be true

    await page.screenshot({ path: 'frontend_admin.png' });

    // Logout
    await page.click('button[data-i18n="logout"]');
    await page.waitForSelector('#login-username');

    // 2. User Login & Screenshot
    console.log('📸 User View...');
    await page.fill('#login-username', 'testuser');
    await page.fill('#login-password', 'password123');
    await page.click('#login-btn');

    await page.waitForSelector('#nav-dashboard');
    await page.waitForTimeout(1000);

    // Check elements visibility
    const statsUserVisible = await page.isVisible('#nav-statistics');
    const securityVisible = await page.isVisible('#nav-security');
    const importVisible = await page.isVisible('#nav-import-export');
    const statsBarVisible = await page.isVisible('#dashboard-stats-bar');
    const epgCardVisible = await page.isVisible('#epg-sources-card');

    console.log('User sees Statistics:', statsUserVisible); // Should be false
    console.log('User sees Security:', securityVisible); // Should be false
    console.log('User sees Import:', importVisible); // Should be false
    console.log('User sees Stats Bar:', statsBarVisible); // Should be false
    console.log('User sees EPG Card:', epgCardVisible); // Should be false

    await page.screenshot({ path: 'frontend_user.png' });

    await browser.close();

  } catch (e) {
    console.error('❌ Error:', e);
  } finally {
    await stopServer();
  }
}

run();
