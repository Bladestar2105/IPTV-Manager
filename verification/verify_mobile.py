from playwright.sync_api import sync_playwright, expect
import re

def test_mobile_ui():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Mobile viewport
        context = browser.new_context(viewport={'width': 375, 'height': 667}, user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1')
        page = context.new_page()

        # Navigate with credentials
        page.goto("http://localhost:3000/player.html?username=admin&password=febf226b5e73b92b")

        # Wait for player to load
        page.wait_for_selector("#player-container")

        # Check for sidebar toggle button
        toggle_btn = page.locator("#sidebar-toggle")
        expect(toggle_btn).to_be_visible()

        # Click it to open sidebar
        toggle_btn.click()

        # Verify sidebar is open
        sidebar = page.locator("#channel-sidebar")
        # Use regex to match 'open' class amongst potentially others
        expect(sidebar).to_have_class(re.compile(r"open"))

        # Screenshot
        page.screenshot(path="/home/jules/verification/mobile_ui.png")
        print("Verification successful, screenshot saved.")

        browser.close()

if __name__ == "__main__":
    test_mobile_ui()
