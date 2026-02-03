
from playwright.sync_api import sync_playwright, expect

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("http://localhost:3000")

        # Wait for the page to load and JS to execute (translation happens on load)
        page.wait_for_load_state("networkidle")

        # Note: Elements are hidden because we are not logged in, but we can still check attributes.

        # 1. Check Generate User Button
        # It should have data-i18n-title="generateRandomUser" and title="Generate Random User" (default en)
        gen_user_btn = page.locator('button[data-i18n-title="generateRandomUser"]')
        expect(gen_user_btn).to_have_attribute("title", "Generate Random User")
        print("✅ Generate User button has correct title")

        # 2. Check Add Category Button (inside tab-channels, might need to be visible or just exist in DOM)
        # It's in the DOM even if tab is not active, but let's check existence first.
        add_cat_btn = page.locator('button[data-i18n-title="addCategory"]')
        expect(add_cat_btn).to_have_count(1)
        expect(add_cat_btn).to_have_attribute("title", "Add Category")
        print("✅ Add Category button has correct title")

        # 3. Check Add EPG Source Button
        add_epg_btn = page.locator('#add-epg-source-btn')
        expect(add_epg_btn).to_have_attribute("title", "Add EPG Source")
        print("✅ Add EPG Source button has correct title")

        # 4. Check Copy Buttons
        # There are multiple copy buttons. Check the first one.
        copy_btn = page.locator('button[data-i18n-title="copyToClipboardAction"]').first
        expect(copy_btn).to_have_attribute("title", "Copy to Clipboard")
        print("✅ Copy button has correct title")

        # Take screenshot
        page.screenshot(path="verification/tooltips.png")
        print("📸 Screenshot taken")

        browser.close()

if __name__ == "__main__":
    run()
