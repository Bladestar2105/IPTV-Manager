import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

def run():
    # Start a simple HTTP server to serve the public directory
    server = subprocess.Popen([sys.executable, "-m", "http.server", "8080", "--directory", "public"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2) # Wait for server to start

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            # Mock Playlist API
            m3u_content = """#EXTM3U
#EXTINF:-1 tvg-id="" tvg-name="Test Movie" tvg-logo="https://placehold.co/100x150" group-title="Action" plot="In a world where testing is paramount, one developer stands alone." cast="John Doe, Jane Smith" director="Spielberg Junior" genre="Action, Sci-Fi" releaseDate="2023-11-01" rating="9.5" duration="145",Test Movie
http://example.com/movie.mp4
"""
            page.route("**/api/player/playlist*", lambda route: route.fulfill(
                status=200,
                content_type="audio/x-mpegurl",
                body=m3u_content
            ))

            # Mock EPG API (empty)
            page.route("**/api/epg/schedule*", lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body="{}"
            ))

            # Mock Proxy Image (pass through or mock)
            page.route("**/api/proxy/image*", lambda route: route.fulfill(
                status=200,
                content_type="image/png",
                body=b"" # Empty image
            ))

            # Navigate to player
            page.goto("http://localhost:8080/player.html?token=test")

            # Wait for init
            page.wait_for_load_state("networkidle")

            # Switch to Movies tab
            # We look for the link with data-type="movie"
            movie_tab = page.locator("#player-tabs .nav-link[data-type='movie']")
            movie_tab.click()

            # Wait for list to render
            page.wait_for_selector(".vod-item")

            # Take screenshot
            page.screenshot(path="verification/movie_metadata.png")
            print("Screenshot saved to verification/movie_metadata.png")

            browser.close()
    finally:
        server.terminate()

if __name__ == "__main__":
    run()
