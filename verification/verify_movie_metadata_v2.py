import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

def run():
    # Use different port to avoid conflicts
    server = subprocess.Popen([sys.executable, "-m", "http.server", "8082", "--directory", "public"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            # Mock Playlist with full metadata
            m3u_content = '#EXTM3U\n#EXTINF:-1 tvg-id="1" tvg-name="Test Movie" group-title="Action" plot="Unique Plot Text" cast="Unique Cast Text" director="Unique Director" genre="Unique Genre" releaseDate="2024" rating="9.9" duration="123",Test Movie\nhttp://example.com/movie/test.mp4'

            page.route("**/api/player/playlist*", lambda route: route.fulfill(
                status=200,
                content_type="audio/x-mpegurl",
                body=m3u_content
            ))

            page.route("**/api/epg/schedule*", lambda route: route.fulfill(status=200, body="{}"))

            page.goto("http://localhost:8082/player.html?token=test")

            # Wait for loading
            page.wait_for_selector("#loading-overlay", state="hidden")

            # Switch to Movies
            page.click("#player-tabs .nav-link[data-type='movie']")

            # Wait for item
            page.wait_for_selector(".vod-item")

            # Screenshot
            page.screenshot(path="verification/movie_metadata_verified.png")

            content = page.content()
            failures = []
            if "Unique Plot Text" not in content: failures.append("Plot missing")
            if "Unique Cast Text" not in content: failures.append("Cast missing")
            if "9.9" not in content: failures.append("Rating missing")
            if "Unique Genre" not in content: failures.append("Genre missing")

            if not failures:
                print("SUCCESS: All metadata fields found!")
            else:
                print(f"FAILURE: {', '.join(failures)}")
                print(content)

            browser.close()
    finally:
        server.terminate()

if __name__ == "__main__":
    run()
