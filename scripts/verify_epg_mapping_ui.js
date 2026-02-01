
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import fetch from 'node-fetch';

const PORT = 3007;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = './test_data_epg_mapping';

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

    // Login Admin to create user
    let res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: 'admin', password: 'adminpass'})
    });
    let data = await res.json();
    const adminToken = data.token;

    res = await fetch(`${BASE_URL}/api/users`, {
        method: 'POST', headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}`},
        body: JSON.stringify({username: 'testuser', password: 'password123'})
    });
    if (!res.ok) throw new Error('Failed to create user');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // 1. Admin Verification
    console.log('📸 Verifying Admin View...');
    await page.goto(BASE_URL);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'adminpass');
    await page.click('#login-btn');
    await page.waitForSelector('#nav-dashboard');

    // Go to EPG Mapping
    await page.click('#nav-epg-mapping');
    await page.waitForSelector('#epg-mode-switcher', { state: 'visible' }); // Should be visible
    console.log('✅ Admin sees Mode Switcher');

    // Switch to Category Mode
    await page.click('label[for="epg-mode-category"]');
    await page.waitForSelector('#epg-mapping-category-container', { state: 'visible' });
    await page.waitForSelector('#epg-mapping-user-select', { state: 'visible' }); // Should see user select
    console.log('✅ Admin sees User Select in Category Mode');

    await page.screenshot({ path: 'epg_mapping_admin.png' });

    // Logout
    await page.click('button[data-i18n="logout"]');
    await page.waitForSelector('#login-username');

    // 2. User Verification
    console.log('📸 Verifying User View...');
    await page.fill('#login-username', 'testuser');
    await page.fill('#login-password', 'password123');
    await page.click('#login-btn');
    await page.waitForSelector('#nav-dashboard');

    // Go to EPG Mapping
    await page.click('#nav-epg-mapping');

    // Check Switcher visibility (should be hidden)
    const switcherVisible = await page.isVisible('#epg-mode-switcher');
    console.log('User sees Mode Switcher:', switcherVisible); // Should be false

    // Check Category Container (should be visible immediately)
    const categoryVisible = await page.isVisible('#epg-mapping-category-container');
    console.log('User sees Category Container:', categoryVisible); // Should be true

    // Check Provider Container (should be hidden)
    const providerVisible = await page.isVisible('#epg-mapping-provider-container');
    console.log('User sees Provider Container:', providerVisible); // Should be false

    await page.screenshot({ path: 'epg_mapping_user.png' });

    await browser.close();

  } catch (e) {
    console.error('❌ Error:', e);
  } finally {
    await stopServer();
  }
}

run();
