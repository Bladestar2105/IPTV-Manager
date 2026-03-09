import sys
from playwright.sync_api import sync_playwright

def verify_geoip(page):
    page.goto("http://localhost:3000")
    page.wait_for_selector('#login-username', timeout=10000)
    page.fill('#login-username', 'admin')
    page.fill('#login-password', 'admin')
    page.click('#login-form button[type="submit"]')
    page.wait_for_timeout(2000)
    page.evaluate('document.getElementById("user-form").scrollIntoView({block: "center"})')
    page.wait_for_timeout(500)
    page.screenshot(path="/home/jules/verification/user_countries.png")

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 1024})
        try:
            verify_geoip(page)
            print("Done")
        except Exception as e:
            print(e)
        finally:
            browser.close()
