import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Config
const PORT = 3001;
const ADMIN_PASS = 'admin123456';
const URL = `http://localhost:${PORT}`;

async function run() {
  console.log('Starting server...');

  const env = {
    ...process.env,
    PORT: PORT.toString(),
    INITIAL_ADMIN_PASSWORD: ADMIN_PASS,
    JWT_SECRET: 'testsecret'
  };

  if (fs.existsSync('db.sqlite')) {
    fs.unlinkSync('db.sqlite');
    console.log('Deleted existing db.sqlite');
  }

  const server = spawn('node', ['src/server.js'], { env, stdio: 'pipe' });

  server.stdout.on('data', (data) => console.log(`[Server]: ${data}`));
  server.stderr.on('data', (data) => console.error(`[Server ERR]: ${data}`));

  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('Starting Playwright...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('dialog', async dialog => {
      console.log(`Dialog message: ${dialog.message()}`);
      await dialog.accept();
  });

  // Mock channels
  await page.route('**/api/providers/*/channels', async route => {
      const json = [
          { id: '1', name: 'Sky Sport 1', logo: '' },
          { id: '2', name: 'Sky Cinema', logo: '' },
          { id: '3', name: 'Discovery', logo: '' },
          { id: '4', name: 'CNN', logo: '' },
          { id: '5', name: 'Disney Channel', logo: '' }
      ];
      await route.fulfill({ json });
  });

  // Mock Available EPG Sources
  await page.route('**/api/epg-sources/available', async route => {
      const json = [
          { name: 'EPG Share 1', url: 'http://epg.example.com/1.xml', size: 5000000 },
          { name: 'IPTV Org', url: 'http://iptv-org.github.io/epg.xml', size: 12000000 }
      ];
      await route.fulfill({ json });
  });

  if (!fs.existsSync('docs/images')) {
      fs.mkdirSync('docs/images', { recursive: true });
  }

  try {
    // 1. Login Page
    console.log('Navigating to login...');
    await page.goto(URL);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'docs/images/login.png' });
    console.log('Snapped login.png');

    // 2. Login
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', ADMIN_PASS);
    await page.click('#login-btn');

    // Wait for main content to be visible
    await page.waitForSelector('#main-content', { state: 'visible' });
    console.log('Logged in.');

    // 3. Create Data
    // Create User
    console.log('Creating User...');
    await page.fill('#user-form input[name="username"]', 'DemoUser');
    await page.fill('#user-form input[name="password"]', 'demo12345');
    await page.click('#user-form button[type="submit"]');

    // Wait for the new user to appear
    await page.waitForSelector('#user-list li');
    console.log('User created.');

    // Select User (the second one, assuming DemoUser is last)
    await page.click('#user-list li:last-child span');
    await page.waitForSelector('#provider-section', { state: 'visible' });

    // Create Provider
    console.log('Creating Provider...');
    await page.click('button[data-i18n="addProvider"]');
    await page.waitForSelector('#add-provider-modal', { state: 'visible' });

    await page.fill('#provider-form input[name="name"]', 'Demo TV');
    await page.fill('#provider-form input[name="url"]', 'http://example.com');
    await page.fill('#provider-form input[name="username"]', 'user');
    await page.fill('#provider-form input[name="password"]', 'pass');
    await page.click('#save-provider-btn');
    // await page.waitForSelector('#add-provider-modal', { state: 'hidden' });

    // Wait for provider list to populate
    await page.waitForSelector('#provider-list li');

    // Force close modal if open
    await page.evaluate(() => {
        const el = document.getElementById('add-provider-modal');
        if (el && el.classList.contains('show')) {
            el.classList.remove('show');
            el.style.display = 'none';
            document.body.classList.remove('modal-open');
            const backdrop = document.querySelector('.modal-backdrop');
            if(backdrop) backdrop.remove();
        }
    });

    console.log('Provider created.');

    // Screenshot: Dashboard
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'docs/images/providers.png' });
    console.log('Snapped providers.png');

    // 4. Categories
    await page.fill('#category-form input[name="name"]', 'Sports');
    await page.click('#category-form button[type="submit"]');
    await page.waitForTimeout(500);
    await page.fill('#category-form input[name="name"]', 'Movies');
    await page.click('#category-form button[type="submit"]');
    await page.waitForSelector('#category-list li:nth-child(2)'); // Wait for 2nd item

    // Select "Sports" category via JS to ensure it works
    // Note: The first span is the drag handle. We need the second span.
    await page.evaluate(() => {
        const span = document.querySelector('#category-list li:first-child span:nth-of-type(2)');
        if (span) span.click();
    });

    await page.waitForSelector('#category-list li:first-child.active');

    await page.screenshot({ path: 'docs/images/categories.png' });
    console.log('Snapped categories.png');

    // 5. Channels
    const providerId = await page.evaluate(() => {
        const sel = document.getElementById('channel-provider-select');
        return sel.options[1].value;
    });
    await page.selectOption('#channel-provider-select', providerId);

    await page.waitForSelector('#provider-channel-list li');

    await page.click('#provider-channel-list li:nth-child(1) button');
    await page.click('#provider-channel-list li:nth-child(2) button');
    await page.waitForSelector('#user-channel-list li');

    await page.screenshot({ path: 'docs/images/channels.png' });
    console.log('Snapped channels.png');

    // 6. Sync Logs
    // Find button inside the provider li
    // Selector: #provider-list li button[title="Sync Logs"]
    // Or check existing buttons: Edit, Sync, Config, Logs, Delete
    // Order: Edit, Sync, Config, Logs, Delete
    const logsBtn = await page.locator('#provider-list li button').nth(3); // 0-based
    await logsBtn.click();
    await page.waitForSelector('#sync-logs-modal', { state: 'visible' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'docs/images/sync_logs.png' });
    console.log('Snapped sync_logs.png');
    await page.click('#sync-logs-modal button[data-bs-dismiss="modal"]');
    await page.waitForSelector('#sync-logs-modal', { state: 'hidden' });

    // 7. EPG Sources
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: 'docs/images/epg_sources.png' });
    console.log('Snapped epg_sources.png');

    // 8. EPG Browse
    await page.click('#browse-epg-sources-btn');
    await page.waitForSelector('#browse-epg-sources-modal', { state: 'visible' });
    await page.waitForSelector('#available-epg-sources-list li button');
    await page.screenshot({ path: 'docs/images/epg_browse.png' });
    console.log('Snapped epg_browse.png');
    await page.click('#browse-epg-sources-modal button[data-bs-dismiss="modal"]');

    // 9. Statistics
    await page.click('#nav-statistics');
    await page.waitForSelector('#view-statistics:not(.d-none)');
    await page.screenshot({ path: 'docs/images/statistics.png' });
    console.log('Snapped statistics.png');

    // 10. Security
    await page.click('#nav-security');
    await page.waitForSelector('#view-security:not(.d-none)');
    await page.fill('#block-ip-form input[name="ip"]', '192.168.1.100');
    await page.fill('#block-ip-form input[name="reason"]', 'Spam');
    await page.click('#block-ip-form button[data-i18n="block"]');
    await page.waitForSelector('#blocked-ip-list li');
    await page.screenshot({ path: 'docs/images/security.png' });
    console.log('Snapped security.png');

    // 11. EPG Mapping
    await page.click('#nav-epg-mapping');
    await page.waitForSelector('#view-epg-mapping:not(.d-none)');
    await page.selectOption('#epg-mapping-provider-select', providerId);
    await page.waitForSelector('#epg-mapping-tbody tr td button');
    await page.screenshot({ path: 'docs/images/epg_mapping.png' });
    console.log('Snapped epg_mapping.png');

  } catch (err) {
    console.error('Simulation failed:', err);
    await page.screenshot({ path: 'docs/images/error_snapshot.png' });
  } finally {
    await browser.close();
    server.kill();
    console.log('Done.');
    process.exit(0);
  }
}

run();
