from playwright.sync_api import sync_playwright
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        # 1. Login
        page.goto("http://localhost:3000")
        page.fill("#login-username", "admin")
        page.fill("#login-password", "admin")
        page.click("#login-btn")

        # Wait for dashboard
        page.wait_for_selector("#nav-dashboard")
        time.sleep(1) # anim

        # 2. Check Statistics Tab exists
        page.screenshot(path="verification/dashboard.png")
        print("📸 Dashboard screenshot taken")

        # 3. Go to Statistics
        page.click("#nav-statistics")
        page.wait_for_selector("#view-statistics")
        time.sleep(1)
        page.screenshot(path="verification/statistics.png")
        print("📸 Statistics screenshot taken")

        # 4. Check Import Modal
        page.click("#nav-dashboard")
        time.sleep(0.5)
        # Need to select a user first to enable import?
        # Create a user first? Or select existing?
        # The test runner created users, but I need to know which one.
        # I'll rely on the dashboard screenshot showing the Import button.

        # If I can select a user...
        # Wait, the list might be empty if I restarted server with fresh DB.
        # But I ran system tests which created data.
        # Let's see if we can find a user in the list.
        try:
            page.click("#user-list li span") # click first user
            time.sleep(0.5)
            page.click("#import-categories-btn")
            page.wait_for_selector("#importCategoryModal")
            time.sleep(1)
            page.screenshot(path="verification/import_modal.png")
            print("📸 Import Modal screenshot taken")
        except Exception as e:
            print(f"⚠️ Could not test import modal: {e}")

        browser.close()

if __name__ == "__main__":
    run()
