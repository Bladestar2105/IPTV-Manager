from playwright.sync_api import sync_playwright, expect
import time

def verify_hdhr_frontend():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 800})
        page = context.new_page()

        try:
            # 1. Login
            print("Navigating to login...")
            page.goto("http://localhost:3000")
            page.fill("#login-username", "admin")
            page.fill("#login-password", "37f304c5e3894221")
            page.click("#login-btn")

            # Wait for dashboard
            expect(page.locator("#view-dashboard")).to_be_visible(timeout=10000)
            print("Logged in.")

            # 2. Create User
            print("Creating test user...")
            page.fill("#user-form input[name='username']", "testuser")
            page.fill("#user-form input[name='password']", "testpassword123")
            page.click("#user-form button[type='submit']")

            # Wait for user to appear in list
            print("Waiting for user in list...")
            page.wait_for_selector("#user-list li", timeout=5000)
            user_list_items = page.locator("#user-list li")

            # 3. Select User
            # Click the span inside the first li
            print("Selecting user (clicking span)...")
            user_list_items.first.locator("span").first.click()

            # Verify selection
            expect(page.locator("#selected-user-label")).to_contain_text("testuser")

            # 4. Check HDHomeRun Tab
            print("Checking HDHomeRun Tab...")
            hdhr_tab_btn = page.locator("#tab-hdhr-btn")
            expect(hdhr_tab_btn).to_be_visible()
            hdhr_tab_btn.click()

            # Wait for tab pane to be visible
            expect(page.locator("#tab-hdhr")).to_be_visible()

            # Verify disabled state initially
            if page.locator("#hdhr-enabled-section").is_visible():
                print("WARNING: HDHR Enabled section is visible unexpectedly!")

            expect(page.locator("#hdhr-disabled-section")).to_be_visible()
            page.screenshot(path="/home/jules/verification/hdhr_disabled.png")
            print("Screenshot saved: hdhr_disabled.png")

            # 5. Edit User
            print("Editing user to enable HDHR...")
            edit_btn = user_list_items.first.locator("button[aria-label='Edit User']")
            edit_btn.click()

            # Wait for modal
            expect(page.locator("#edit-user-modal")).to_be_visible()

            # Check Enable HDHomeRun
            checkbox = page.locator("#edit-user-hdhr-enabled")
            if not checkbox.is_checked():
                checkbox.check()

            # Save
            page.click("#edit-user-form button[type='submit']")

            # Wait for toast or modal close
            time.sleep(2)

            # 6. Verify Enabled
            print("Verifying enabled state...")
            # Re-click the user to refresh details
            user_list_items.first.locator("span").first.click()
            hdhr_tab_btn.click()

            expect(page.locator("#hdhr-enabled-section")).to_be_visible()
            expect(page.locator("#hdhr-url")).not_to_be_empty()

            # Check URL format
            url = page.locator("#hdhr-url").input_value()
            print(f"HDHR URL: {url}")

            page.screenshot(path="/home/jules/verification/hdhr_enabled.png")
            print("Screenshot saved: hdhr_enabled.png")

        except Exception as e:
            print(f"Error: {e}")
            page.screenshot(path="/home/jules/verification/error.png")
            print("Error screenshot saved.")
            raise e
        finally:
            browser.close()

if __name__ == "__main__":
    verify_hdhr_frontend()
