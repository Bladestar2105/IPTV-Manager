import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';

const db = new Database('db.sqlite');
const hash = bcrypt.hashSync('admin123', 10);
db.prepare("UPDATE admin_users SET password = ?, force_password_change = 0 WHERE username = 'admin'").run(hash);
db.close();

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:3000');

  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-form button[type="submit"]');

  await page.waitForTimeout(2000); // Wait for load
  await page.screenshot({ path: 'initial_state.png', fullPage: true });

  await browser.close();
})();
