import { chromium } from 'playwright';
import app from '../src/app.js';
import { initDb } from '../src/database/db.js';
import { initEpgDb } from '../src/database/epgDb.js';

async function run() {
  initDb(true);
  initEpgDb();

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
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
