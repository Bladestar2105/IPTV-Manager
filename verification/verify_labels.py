
from playwright.sync_api import sync_playwright, expect

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("http://localhost:3000")

        # Wait for the page to load and JS to execute
        page.wait_for_load_state("networkidle")

        # Check Username Input in User Form
        username_input = page.locator('#user-form input[name="username"]')
        expect(username_input).to_have_attribute("aria-label", "Username")
        print("✅ Username input has correct aria-label")

        # Check Password Input in User Form
        password_input = page.locator('#user-form input[name="password"]')
        expect(password_input).to_have_attribute("aria-label", "Password")
        print("✅ Password input has correct aria-label")

        # Check Channel Search
        channel_search = page.locator('#channel-search')
        expect(channel_search).to_have_attribute("aria-label", "🔍 Search channels...")
        print("✅ Channel search has correct aria-label")

        # Take screenshot
        page.screenshot(path="verification/verification.png")
        print("📸 Screenshot taken")

        browser.close()

if __name__ == "__main__":
    run()
