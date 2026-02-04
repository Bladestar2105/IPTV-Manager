from playwright.sync_api import sync_playwright

def debug_login():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto("http://localhost:3000/index.html")

        try:
            page.wait_for_selector("#login-modal", state="visible", timeout=5000)
            print("Login modal visible.")
            page.fill("#login-username", "admin")
            page.fill("#login-password", "febf226b5e73b92b")
            page.click("#login-btn")
            page.wait_for_timeout(2000)

            error = page.locator("#login-error")
            if error.is_visible():
                print(f"Login Error: {error.inner_text()}")

            main_content = page.locator("#main-content")
            # Wait for main content
            try:
                main_content.wait_for(state="visible", timeout=5000)
                print("Main Content Visible.")
            except:
                print("Main Content NOT Visible.")

        except Exception as e:
            print(f"Login modal not found or other error: {e}")

        browser.close()

if __name__ == "__main__":
    debug_login()
