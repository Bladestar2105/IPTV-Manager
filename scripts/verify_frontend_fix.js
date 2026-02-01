
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import fetch from 'node-fetch';

const PORT = 3006;
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = './test_data_frontend_fix';

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

    // 2. User Login & Verification
    console.log('📸 User View...');
    await page.goto(BASE_URL);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', 'testuser');
    await page.fill('#login-password', 'password123');
    await page.click('#login-btn');

    // Check for Loop / Success
    try {
        await page.waitForSelector('#nav-dashboard', { timeout: 5000 });
        console.log('✅ Login successful, dashboard visible.');

        // Wait a bit to ensure no redirect back to login
        await page.waitForTimeout(3000);

        const loginVisible = await page.isVisible('#login-modal');
        if (loginVisible) {
            console.error('❌ Login Loop Detected! Login modal reappeared.');
        } else {
            console.log('✅ No Login Loop Detected.');
        }

    } catch(e) {
        console.error('❌ Login failed or timed out:', e);
    }

    // Check "Add Provider" button visibility
    const addProviderVisible = await page.isVisible('#add-provider-btn');
    console.log('User sees Add Provider Button:', addProviderVisible); // Should be false

    if (!addProviderVisible) {
        console.log('✅ Add Provider Button correctly hidden.');
    } else {
        console.error('❌ Add Provider Button is visible!');
    }

    await page.screenshot({ path: 'frontend_fix_verification.png' });

    await browser.close();

  } catch (e) {
    console.error('❌ Error:', e);
  } finally {
    await stopServer();
  }
}

run();
