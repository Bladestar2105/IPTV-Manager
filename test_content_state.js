import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');

  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type="submit"]');

  await page.waitForTimeout(2000); // Wait for load

  // Click on the user list group item
  await page.click('#user-list .list-group-item');
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'content_state.png', fullPage: true });

  await browser.close();
})();
