from playwright.sync_api import sync_playwright
import os

def run(playwright):
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()

    # Load local file
    file_path = os.path.abspath("public/index.html")
    page.goto(f"file://{file_path}")

    # Inject logic to show a toast
    page.evaluate("""
        // Manually creating a toast structure similar to what showToast does
        const container = document.getElementById('toast-container');
        if(container) {
            const el = document.createElement('div');
            el.className = 'toast show align-items-center text-white bg-success border-0 shadow-lg mb-2';
            el.innerHTML = `
                <div class="d-flex">
                    <div class="toast-body d-flex align-items-center gap-2">
                        <span class="fs-5">✅</span>
                        <div>Test Success Toast</div>
                    </div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto"></button>
                </div>
            `;
            container.appendChild(el);

            const el2 = document.createElement('div');
            el2.className = 'toast show align-items-center text-white bg-danger border-0 shadow-lg';
            el2.innerHTML = `
                <div class="d-flex">
                    <div class="toast-body d-flex align-items-center gap-2">
                        <span class="fs-5">⚠️</span>
                        <div>Test Error Toast</div>
                    </div>
                    <button type="button" class="btn-close btn-close-white me-2 m-auto"></button>
                </div>
            `;
            container.appendChild(el2);
        }
    """)

    # Wait for rendering
    page.wait_for_timeout(1000)

    page.screenshot(path="public/verification/toast_verify_py.png")
    browser.close()

with sync_playwright() as playwright:
    run(playwright)
