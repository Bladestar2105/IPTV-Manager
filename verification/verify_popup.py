from playwright.sync_api import sync_playwright, expect

def test_popup_window():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Standard context
        context = browser.new_context()
        page = context.new_page()

        try:
            # Login
            page.goto("http://localhost:3000/index.html")

            # Wait for modal
            page.wait_for_selector("#login-modal", state="visible")

            page.fill("#login-username", "admin")
            page.fill("#login-password", "febf226b5e73b92b")
            page.click("#login-btn")

            # Wait for main content
            page.wait_for_selector("#main-content", state="visible")

            # Create a test user
            page.wait_for_selector("input[name='username']", state="visible")
            page.fill("input[name='username']", "testuser")
            page.fill("input[name='password']", "password123")
            page.click("button[type='submit'][data-i18n='addUser']")

            # Wait for user to appear in list
            page.wait_for_selector("#user-list li span:has-text('testuser')", state="visible")

            user_li = page.locator("#user-list li").filter(has_text="testuser")
            play_btn = user_li.locator("button.btn-outline-success")

            # Setup popup listener
            with page.expect_popup() as popup_info:
                play_btn.click()

            popup = popup_info.value

            # Wait for URL to change from about:blank to player.html
            # Give it some time for the fetch to complete
            popup.wait_for_url("**/player.html?token=*", timeout=10000)

            print(f"Popup loaded URL: {popup.url}")

            # Verify URL params
            assert "player.html" in popup.url
            assert "token=" in popup.url

            # Take screenshot
            page.screenshot(path="/home/jules/verification/user_list_popup.png")
            print("Verification successful.")

        except Exception as e:
            print(f"Error: {e}")
            page.screenshot(path="/home/jules/verification/error.png")
            raise e
        finally:
            browser.close()

if __name__ == "__main__":
    test_popup_window()
