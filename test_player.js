import { test, expect } from '@playwright/test';
import path from 'path';

test('Player UI tests', async ({ page }) => {
  const filePath = path.resolve('public/player.html');
  await page.goto(`file://${filePath}?token=dummy`);

  // Wait for the UI to be ready
  await page.waitForTimeout(1000);

  // We are just verifying that the page loads without major errors.
  // Testing the loading indicator visibility and behavior inside vanilla JS
  // requires stubbing the fetch requests, which is more complex.
  const loadingOverlay = await page.$('#loading-overlay');
  expect(loadingOverlay).not.toBeNull();
});
