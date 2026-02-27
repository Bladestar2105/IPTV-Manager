const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Navigate to local file
  // Since we don't have a full backend running in this env easily,
  // we load index.html directly.
  // Note: app.js logic mostly runs on DOMContentLoaded but depends on fetch which will fail.
  // However, we can mock fetch or just verify static structure.

  // Actually, without a running server, many parts of app.js won't initialize fully
  // or will error out on fetch.
  // But we can check if the Toast container exists, which is static in index.html

  const filePath = path.resolve(__dirname, '../index.html');
  await page.goto(`file://${filePath}`);

  // Inject a toast manually to verify styling since we can't easily trigger the async actions without backend
  await page.evaluate(() => {
    // Mock the showToast function if it's not globally available or if we want to test it directly
    // app.js defines showToast in global scope effectively by attaching it to window or just being in global scope

    // Check if showToast exists
    if (typeof showToast === 'function') {
        showToast('Test Success Toast', 'success');
        setTimeout(() => showToast('Test Error Toast', 'danger'), 500);
    } else {
        // Fallback manual injection if showToast isn't exposed (it is top level in app.js but might not be window.showToast)
        // In app.js it is defined as function showToast(...) so it should be available.
        // But app.js might error out before reaching it due to missing backend.

        // Let's manually create one to see if CSS works
        const container = document.getElementById('toast-container');
        if(container) {
            const el = document.createElement('div');
            el.className = 'toast show align-items-center text-white bg-success border-0 shadow-lg';
            el.innerHTML = '<div class="d-flex"><div class="toast-body">Manual Toast Test</div></div>';
            container.appendChild(el);
        }
    }
  });

  // Wait a bit for toast to appear
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'public/verification/toast_verify.png' });

  await browser.close();
})();
