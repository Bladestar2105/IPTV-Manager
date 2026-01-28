from playwright.sync_api import sync_playwright, expect
import re

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context()
    page = context.new_page()

    # 1. Login
    print("Navigating to login...")
    page.goto("http://localhost:3000")

    # Wait for login modal
    page.wait_for_selector("#login-modal")

    # Fill login
    print("Logging in...")
    page.fill("#login-username", "admin")
    page.fill("#login-password", "d72e940805ba5d0a")
    page.click("#login-btn")

    # Wait for dashboard
    page.wait_for_selector("#view-dashboard")
    expect(page.locator("#main-navbar")).to_be_visible()

    # 2. Verify M3U Link Section
    print("Verifying M3U Link...")
    # Using locator with text content since data-i18n might be used for initial load but structure is h3
    m3u_section = page.locator("h3", has_text="6. M3U Playlist")
    expect(m3u_section).to_be_visible()

    m3u_link = page.locator("#m3u-link")
    expect(m3u_link).to_be_visible()
    # Check for substring
    text = m3u_link.text_content()
    if "/get.php?username=DUMMY&password=DUMMY&type=m3u&output=ts" not in text:
        raise Exception(f"M3U Link content incorrect: {text}")

    # 3. Verify Security View Hidden
    print("Verifying Security View Hidden...")
    security_view = page.locator("#view-security")
    # It should have class d-none
    expect(security_view).to_have_class(re.compile(r"d-none"))

    # 4. Switch to Security
    print("Switching to Security...")
    # Click the nav link
    page.click("a[id='nav-security']")

    # Verify Security View Visible
    # to_have_class passes if regex matches. We want to ensure it DOES NOT have d-none.
    # expect(security_view).not_to_have_class(re.compile(r"d-none")) might not work as intended if it has other classes.
    # Let's check class attribute string directly.

    # Wait for animation/js
    page.wait_for_timeout(500)

    classes = security_view.get_attribute("class")
    if "d-none" in classes:
        raise Exception("Security view still has d-none class!")

    # Verify Dashboard Hidden
    dashboard_view = page.locator("#view-dashboard")
    expect(dashboard_view).to_have_class(re.compile(r"d-none"))

    # 5. Verify New Forms
    print("Verifying Security Forms...")

    # Duration Select
    duration_select = page.locator("select[name='duration']")
    expect(duration_select).to_be_visible()

    # Whitelist Description
    description_input = page.locator("input[name='description']")
    expect(description_input).to_be_visible()

    # Screenshot
    page.screenshot(path="verification/ui_verified.png")
    print("✅ Verification Complete. Screenshot saved.")

    browser.close()

if __name__ == "__main__":
    with sync_playwright() as playwright:
        run(playwright)
