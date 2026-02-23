import sys
import time
import subprocess
from playwright.sync_api import sync_playwright

def run():
    # Start server serving the current directory (project root) so /public/player.html is accessible at /public/player.html
    # But wait, public/player.html refers to /api/... which is relative to root.
    # The previous script served  as root. So  was correct.
    # But  would hit  on the python server which is 404.
    # But I mocked the route in playwright. So 404 on server doesn't matter IF playwright intercepts it.

    server = subprocess.Popen([sys.executable, "-m", "http.server", "8081", "--directory", "public"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()

            # Listen to console
            page.on("console", lambda msg: print(f"BROWSER: {msg.text}"))
            page.on("pageerror", lambda err: print(f"BROWSER ERROR: {err}"))

            # Mock Playlist
            m3u_content = """#EXTM3U
#EXTINF:-1 tvg-id="1" tvg-name="Test Movie" tvg-logo="" group-title="Action" plot="A legendary test movie plot." cast="Actor A, Actor B" director="Director X" genre="Action, Sci-Fi" releaseDate="2023-11-01" rating="9.5" duration="145",Test Movie
http://example.com/movie/user/pass/123.mp4
"""
            # Note: I added /movie/ to the URL to ensure regex matches

            def handle_playlist(route):
                print("Intercepted playlist request")
                route.fulfill(
                    status=200,
                    content_type="audio/x-mpegurl",
                    body=m3u_content
                )

            page.route("**/api/player/playlist*", handle_playlist)

            page.route("**/api/epg/schedule*", lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body="{}"
            ))

            # Navigate
            print("Navigating...")
            page.goto("http://localhost:8081/player.html?token=test")

            # Wait for loading to finish
            try:
                page.wait_for_selector("#loading-overlay", state="hidden", timeout=5000)
                print("Loading overlay hidden")
            except:
                print("Loading overlay still visible?")

            # Switch to Movies tab
            print("Switching to Movies...")
            page.evaluate("document.querySelector('#player-tabs .nav-link[data-type=\"movie\"]').click()")

            # Wait for rendering
            time.sleep(2)

            print("Taking screenshot...")
            page.screenshot(path="verification/movie_metadata_debug.png")

            # Check content
            content = page.content()
            if "A legendary test movie plot" in content:
                print("SUCCESS: Plot found in page content")
            else:
                print("FAILURE: Plot NOT found in page content")

            browser.close()
    finally:
        server.terminate()

if __name__ == "__main__":
    run()
