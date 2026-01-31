## 2024-05-22 - SSRF via Proxy Features
**Vulnerability:** Found a Server-Side Request Forgery (SSRF) vulnerability in the HLS segment proxy (`/live/segment/...`). The endpoint blindly followed user-supplied URLs, allowing authenticated users to access internal network services (localhost) or cloud metadata services.
**Learning:** Proxy features in IPTV applications are essential for playback but dangerous if not scoped. Simple protocol checks (`http`) are insufficient; explicit IP/hostname blocklisting is required for loopback and link-local addresses.
**Prevention:** Implement strict input validation for proxy targets. Block `localhost`, `127.0.0.0/8`, `::1`, and `169.254.169.254`.
