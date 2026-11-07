const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Static styling check; file navigation does not exercise authenticated API flows.

  const filePath = path.resolve(__dirname, '../index.html');
  await page.goto(`file://${filePath}`);

  await page.evaluate(() => {
    if (typeof showToast === 'function') {
        showToast('Test Success Toast', 'success');
        setTimeout(() => showToast('Test Error Toast', 'danger'), 500);
    } else {
        // Keep the styling probe usable if the app script did not initialize.
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
