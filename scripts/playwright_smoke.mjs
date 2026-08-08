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

async function waitForLoginModal(page) {
  await page.locator('#login-modal').waitFor({state: 'visible', timeout: 15000});
  await page.waitForFunction(() => {
    const modal = document.getElementById('login-modal');
    return modal?.classList.contains('show') && modal.getAttribute('aria-modal') === 'true';
  }, undefined, {timeout: 15000});
}

async function login(page, baseUrl, username, password, {reload = true} = {}) {
  if (reload) await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await waitForLoginModal(page);
  await page.locator('#login-username').fill(username);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-btn').click();
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#login-modal').waitFor({ state: 'hidden', timeout: 15000 });
}

async function assertVisible(locator, message) {
  try {
    await locator.waitFor({state: 'visible', timeout: 15000});
  } catch {
    throw new Error(message);
  }
}

async function assertHidden(locator, message) {
  try {
    await locator.waitFor({state: 'hidden', timeout: 15000});
  } catch {
    throw new Error(message);
  }
}

async function run() {
  let server;
  let browser;
  let page;
  let adminPage;
  let grantedUserPage;

  try {
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
    return {type, categoryName, categoryId, channelName, providerChannelId, userChannelId};
  });
  const liveFixture = listFixtures[0];

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  adminPage = await browser.newPage();
  grantedUserPage = await browser.newPage();

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

    await assertVisible(page.locator('#nav-epg-mapping'), 'Regular users must retain EPG Mapping');
    await page.locator('#nav-epg-mapping').click();
    await page.locator(`#epg-mapping-category-select option[value="${liveFixture.categoryId}"]`)
      .waitFor({state: 'attached', timeout: 15000});
    await page.locator('#epg-mapping-category-select').selectOption(String(liveFixture.categoryId));
    await page.locator('#epg-mapping-tbody').getByText(liveFixture.channelName, {exact: true})
      .waitFor({state: 'visible', timeout: 15000});
    const mappingStatuses = await page.evaluate(async ({providerChannelId}) => {
      const token = localStorage.getItem('jwt_token');
      const response = await fetch('/api/mapping/manual', {
        method: 'POST',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({provider_channel_id: providerChannelId, epg_channel_id: 'playwright-epg-channel'})
      });
      return response.status;
    }, liveFixture);
    if (mappingStatuses !== 200) throw new Error(`Regular user EPG mapping failed: ${mappingStatuses}`);

    await login(adminPage, baseUrl, adminUsername, adminPassword);
    await assertVisible(adminPage.locator('#user-section'), 'Admins must see User Management');
    const userRow = adminPage.locator('#user-list li').filter({hasText: userUsername});
    await userRow.waitFor({state: 'visible', timeout: 15000});
    await userRow.getByText(userUsername, {exact: false}).first().click();
    await adminPage.locator(`#channel-provider-select option[value="${providerId}"]`)
      .waitFor({state: 'attached', timeout: 15000});
    await adminPage.locator('#channel-provider-select').selectOption(String(providerId));
    await adminPage.locator('#provider-channel-list').getByText(liveFixture.channelName, {exact: true})
      .waitFor({state: 'visible', timeout: 15000});
    await adminPage.locator('#nav-epg-mapping').click();
    await adminPage.locator(`#epg-mapping-provider-select option[value="${providerId}"]`)
      .waitFor({state: 'attached', timeout: 15000});
    await adminPage.locator('#epg-mapping-provider-select').selectOption(String(providerId));
    await adminPage.locator('#epg-mapping-tbody').getByText(liveFixture.channelName, {exact: true})
      .waitFor({state: 'visible', timeout: 15000});
    await adminPage.locator('[data-action="action-logout"]').click();
    await waitForLoginModal(adminPage);
    await login(adminPage, baseUrl, userUsername, userPassword, {reload: false});
    await assertHidden(adminPage.locator('#provider-section'), 'Logout must clear provider access UI');
    await assertHidden(adminPage.locator('#epg-mapping-provider-container'), 'Logout must clear provider EPG UI');
    if (await adminPage.locator(`#epg-mapping-provider-select option[value="${providerId}"]`).count()) {
      throw new Error('Provider EPG options leaked into the next normal-user session');
    }
    if (await adminPage.locator('#provider-channel-list').getByText(liveFixture.channelName, {exact: true}).count()) {
      throw new Error('Provider catalog leaked into the next normal-user session');
    }
    await adminPage.locator('#nav-epg-mapping').click();
    await adminPage.locator(`#epg-mapping-category-select option[value="${liveFixture.categoryId}"]`)
      .waitFor({state: 'attached', timeout: 15000});
    await adminPage.locator('#epg-mapping-category-select').selectOption(String(liveFixture.categoryId));
    await adminPage.locator('#epg-mapping-tbody').getByText(liveFixture.channelName, {exact: true})
      .waitFor({state: 'visible', timeout: 15000});

    await adminPage.locator('[data-action="action-logout"]').click();
    await waitForLoginModal(adminPage);
    await login(adminPage, baseUrl, adminUsername, adminPassword, {reload: false});
    await adminPage.locator('#nav-dashboard').click();
    await adminPage.locator('#view-dashboard').waitFor({state: 'visible', timeout: 15000});
    await assertVisible(adminPage.locator('#user-section'), 'Admins must see User Management after relogin');
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
    await assertVisible(grantedUserPage.locator('#nav-epg-mapping'), 'Granted users must retain EPG Mapping');
    await grantedUserPage.locator('#provider-list').getByText(providerName).waitFor({state: 'visible', timeout: 15000});

    const revokeStatus = await adminPage.evaluate(async ({userId}) => {
      const token = localStorage.getItem('jwt_token');
      const response = await fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({provider_access: false})
      });
      return response.status;
    }, {userId});
    if (revokeStatus !== 200) throw new Error(`Provider access revoke failed: ${revokeStatus}`);

    const deniedCatalog = await grantedUserPage.evaluate(async ({providerId}) => {
      try {
        await window.fetchJSON(`/api/providers/${providerId}/channels?type=live`);
        return {message: 'unexpected success', token: Boolean(localStorage.getItem('jwt_token'))};
      } catch (error) {
        return {message: error.message, token: Boolean(localStorage.getItem('jwt_token'))};
      }
    }, {providerId});
    if (deniedCatalog.message !== 'Access denied' || !deniedCatalog.token) {
      throw new Error(`Provider denial must preserve the login session: ${JSON.stringify(deniedCatalog)}`);
    }
    await assertHidden(grantedUserPage.locator('#login-modal'), 'Provider denial must not show the login modal');
    await assertHidden(grantedUserPage.locator('#provider-section'), 'Revoked users must lose the Provider section');
    await assertVisible(grantedUserPage.locator('#user-details-content'), 'Provider denial must preserve list editing');
    await grantedUserPage.locator('#nav-epg-mapping').click();
    await grantedUserPage.locator(`#epg-mapping-category-select option[value="${liveFixture.categoryId}"]`)
      .waitFor({state: 'attached', timeout: 15000});
    await grantedUserPage.locator('#epg-mapping-category-select').selectOption(String(liveFixture.categoryId));
    await grantedUserPage.locator('#epg-mapping-tbody').getByText(liveFixture.channelName, {exact: true})
      .waitFor({state: 'visible', timeout: 15000});
  } finally {
    for (const currentPage of [page, adminPage, grantedUserPage]) {
      try { await currentPage?.close(); } catch {}
    }
    try { await browser?.close(); } catch {}
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (!configuredDataDir) rmSync(smokeDataDir, {recursive: true, force: true});
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
