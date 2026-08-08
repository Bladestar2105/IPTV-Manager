import { chromium } from 'playwright';
import bcrypt from 'bcrypt';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configuredDataDir = process.env.DATA_DIR;
const smokeDataDir = configuredDataDir || mkdtempSync(join(tmpdir(), 'iptv-manager-playwright-'));
process.env.DATA_DIR = smokeDataDir;

const { default: app } = await import('../src/app.js');
const { default: db, initDb } = await import('../src/database/db.js');
const { initEpgDb } = await import('../src/database/epgDb.js');
const { encrypt } = await import('../src/utils/crypto.js');

async function login(page, baseUrl, username, password) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-btn').click();
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15000 });
}

async function assertVisible(locator, message) {
  if (!(await locator.isVisible())) throw new Error(message);
}

async function assertHidden(locator, message) {
  if (await locator.isVisible()) throw new Error(message);
}

async function run() {
  initDb(true);
  initEpgDb();

  const adminUsername = `pw_admin_${Date.now()}`;
  const userUsername = `pw_user_${Date.now()}`;
  const adminPassword = 'AdminPassword123!';
  const userPassword = 'UserPassword123!';
  const passwordHash = await bcrypt.hash(adminPassword, 4);
  const userPasswordHash = await bcrypt.hash(userPassword, 4);

  db.prepare('INSERT INTO admin_users (username, password, is_active) VALUES (?, ?, 1)')
    .run(adminUsername, passwordHash);
  const userId = db.prepare(`
    INSERT INTO users (username, password, provider_access, webui_access)
    VALUES (?, ?, 0, 1)
  `).run(userUsername, userPasswordHash).lastInsertRowid;
  const providerName = `Playwright Provider ${Date.now()}`;
  const providerId = Number(db.prepare(`
    INSERT INTO providers (name, url, username, password, user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(providerName, 'http://provider.example', 'upstream', encrypt('secret'), userId).lastInsertRowid);
  const listFixtures = ['live', 'movie', 'series'].map((type, index) => {
    const categoryName = `Playwright ${type} Category ${Date.now()}`;
    const categoryId = Number(db.prepare(`
      INSERT INTO user_categories (user_id, name, type)
      VALUES (?, ?, ?)
    `).run(userId, categoryName, type).lastInsertRowid);
    const channelName = `Playwright ${type} Channel ${Date.now()}`;
    const providerChannelId = Number(db.prepare(`
      INSERT INTO provider_channels (provider_id, remote_stream_id, name, stream_type)
      VALUES (?, ?, ?, ?)
    `).run(providerId, 1001 + index, channelName, type).lastInsertRowid);
    const userChannelId = Number(db.prepare(`
      INSERT INTO user_channels (user_category_id, provider_channel_id, sort_order, assignment_origin)
      VALUES (?, ?, 0, 'manual')
    `).run(categoryId, providerChannelId).lastInsertRowid);
    return {type, categoryName, categoryId, channelName, userChannelId};
  });
  const liveFixture = listFixtures[0];

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const adminPage = await browser.newPage();
  const grantedUserPage = await browser.newPage();

  try {
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 15000 });
    if (!response || response.status() >= 400) {
      throw new Error(`Unexpected response status: ${response ? response.status() : 'no response'}`);
    }

    const title = await page.title();
    if (!title || !title.toLowerCase().includes('iptv-manager')) {
      throw new Error(`Unexpected page title: "${title}"`);
    }

    // Smoke-check static container that is required by the web app.
    const toastContainer = await page.$('#toast-container');
    if (!toastContainer) {
      throw new Error('Missing #toast-container in UI');
    }

    await login(page, baseUrl, userUsername, userPassword);
    await assertHidden(page.locator('#user-section'), 'Regular users must not see User Management');
    await assertHidden(page.locator('#provider-section'), 'Provider section must be hidden by default');
    const deniedResponse = await page.evaluate(async () => {
      const token = localStorage.getItem('jwt_token');
      const response = await fetch('/api/providers', {headers: {Authorization: `Bearer ${token}`}});
      return response.status;
    });
    if (deniedResponse !== 403) throw new Error(`Expected provider API denial, got ${deniedResponse}`);
    await assertVisible(page.locator('#user-details-content'), 'Regular users must retain list editing details');
    const category = page.locator('#category-list').getByText(liveFixture.categoryName, {exact: true});
    await category.waitFor({state: 'visible', timeout: 15000});
    await category.click();
    await page.locator('#user-channel-list').getByText(liveFixture.channelName, {exact: true}).waitFor({state: 'visible', timeout: 15000});
    for (const fixture of listFixtures.slice(1)) {
      await page.locator(`label[for="cat-filter-${fixture.type}"]`).click();
      const typeCategory = page.locator('#category-list').getByText(fixture.categoryName, {exact: true});
      await typeCategory.waitFor({state: 'visible', timeout: 15000});
      await typeCategory.click();
      await page.locator('#user-channel-list').getByText(fixture.channelName, {exact: true}).waitFor({state: 'visible', timeout: 15000});
    }
    const listEditStatuses = await page.evaluate(async ({categoryId, userChannelId}) => {
      const token = localStorage.getItem('jwt_token');
      const headers = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
      const [categoryResponse, channelResponse] = await Promise.all([
        fetch(`/api/user-categories/${categoryId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({name: 'Edited Playwright Category'})
        }),
        fetch(`/api/user-channels/${userChannelId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({custom_name: 'Edited Playwright Channel'})
        })
      ]);
      return [categoryResponse.status, channelResponse.status];
    }, {categoryId: liveFixture.categoryId, userChannelId: liveFixture.userChannelId});
    if (listEditStatuses.some(status => status !== 200)) {
      throw new Error(`Regular user list editing failed: ${listEditStatuses.join(', ')}`);
    }

    await login(adminPage, baseUrl, adminUsername, adminPassword);
    await assertVisible(adminPage.locator('#user-section'), 'Admins must see User Management');
    const userRow = adminPage.locator('#user-list li').filter({hasText: userUsername});
    await userRow.waitFor({state: 'visible', timeout: 15000});
    await userRow.locator('button[aria-label="Edit User"]').click();
    if (await adminPage.locator('#edit-user-provider-access').isChecked()) {
      throw new Error('Provider access must be disabled by default');
    }
    await adminPage.locator('#edit-user-provider-access').check();
    await Promise.all([
      adminPage.waitForResponse(response => response.url().includes(`/api/users/${userId}`) && response.request().method() === 'PUT'),
      adminPage.locator('#edit-user-form button[type="submit"]').click()
    ]);

    await login(grantedUserPage, baseUrl, userUsername, userPassword);
    await assertHidden(grantedUserPage.locator('#user-section'), 'Regular users must not see User Management after grant');
    await assertVisible(grantedUserPage.locator('#provider-section'), 'Granted users must see the Provider section');
    await grantedUserPage.locator('#provider-list').getByText(providerName).waitFor({state: 'visible', timeout: 15000});
  } finally {
    await page.close();
    await adminPage.close();
    await grantedUserPage.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (!configuredDataDir) rmSync(smokeDataDir, {recursive: true, force: true});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
