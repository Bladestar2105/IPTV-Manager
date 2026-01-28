
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const PORT = 3001; // Use a different port for testing
const URL = `http://localhost:${PORT}`;

let serverProcess;

async function startServer() {
  return new Promise((resolve, reject) => {
    // Set PORT env var
    const env = { ...process.env, PORT: PORT.toString(), INITIAL_ADMIN_PASSWORD: 'admin' };
    serverProcess = spawn('node', ['server.js'], { env, stdio: 'pipe' });

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes(`http://localhost:${PORT}`)) {
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`Server Error: ${data}`);
    });

    serverProcess.on('error', (err) => {
      reject(err);
    });
  });
}

async function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
  }
}

async function runTest() {
  console.log('🚀 Starting EPG Mapping Test...');

  // Start server
  try {
    await startServer();
    console.log('✅ Server started');
  } catch (e) {
    console.error('❌ Failed to start server:', e);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // 1. Login
    console.log('➡️  Logging in...');
    await page.goto(URL);
    await page.waitForSelector('#login-modal');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'admin'); // Default password from env
    await page.click('#login-btn');

    // Wait for main content
    await page.waitForSelector('#main-content', { state: 'visible' });
    console.log('✅ Login successful');

    // 2. Check Navbar
    console.log('➡️  Checking Navbar...');
    const navbarVisible = await page.isVisible('#main-navbar');
    if (!navbarVisible) throw new Error('Navbar not visible');
    console.log('✅ Navbar found');

    // 3. Navigate to EPG Mapping
    console.log('➡️  Navigating to EPG Mapping...');
    await page.click('#nav-epg-mapping');

    // 4. Verify EPG Mapping View
    await page.waitForSelector('#view-epg-mapping:not(.d-none)');
    const dashboardHidden = await page.evaluate(() => {
        return document.getElementById('view-dashboard').classList.contains('d-none');
    });

    if (!dashboardHidden) throw new Error('Dashboard view should be hidden');

    // Check key elements
    const providerSelect = await page.isVisible('#epg-mapping-provider-select');
    const autoMapBtn = await page.isVisible('#auto-map-btn');
    const channelTable = await page.isVisible('#epg-mapping-tbody');

    if (!providerSelect) throw new Error('Provider select missing');
    if (!autoMapBtn) throw new Error('Auto Map button missing');
    if (!channelTable) throw new Error('Channel table missing');

    console.log('✅ EPG Mapping view verified');

    // 5. Take Screenshot
    await page.screenshot({ path: 'epg_mapping_test.png' });
    console.log('📸 Screenshot saved: epg_mapping_test.png');

  } catch (error) {
    console.error('❌ Test Failed:', error);
    await page.screenshot({ path: 'test_failure.png' });
    process.exit(1);
  } finally {
    await browser.close();
    await stopServer();
  }
}

runTest();
