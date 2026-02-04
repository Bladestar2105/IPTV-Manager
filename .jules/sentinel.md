## 2024-05-22 - SSRF via Proxy Features
**Vulnerability:** Found a Server-Side Request Forgery (SSRF) vulnerability in the HLS segment proxy (`/live/segment/...`). The endpoint blindly followed user-supplied URLs, allowing authenticated users to access internal network services (localhost) or cloud metadata services.
**Learning:** Proxy features in IPTV applications are essential for playback but dangerous if not scoped. Simple protocol checks (`http`) are insufficient; explicit IP/hostname blocklisting is required for loopback and link-local addresses.
**Prevention:** Implement strict input validation for proxy targets. Block `localhost`, `127.0.0.0/8`, `::1`, and `169.254.169.254`.

## 2024-05-23 - DNS Rebinding Bypass in SSRF Protection
**Vulnerability:** The `isSafeUrl` function only validated the hostname string (e.g., blocking 'localhost' or '127.0.0.1') but did not resolve DNS. This allowed attackers to bypass SSRF protection by using domains like `localtest.me` that resolve to `127.0.0.1`.
**Learning:** String-based blocking of hostnames is insufficient against SSRF. You must resolve the hostname to an IP address and validate the *resolved IP* to prevent DNS rebinding attacks or simple bypasses.
**Prevention:** Use `dns.lookup` to resolve the hostname to an IP, and then check the IP against blocklists (private ranges, loopback) before allowing the connection.
