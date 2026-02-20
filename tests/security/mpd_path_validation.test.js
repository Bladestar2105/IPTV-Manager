import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyMpd } from "../../src/controllers/streamController.js";

// Mock dependencies
vi.mock("node-fetch");
vi.mock("../../src/services/authService.js");
vi.mock("../../src/services/streamManager.js");
vi.mock("../../src/database/db.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));
vi.mock("../../src/utils/helpers.js", () => ({
  getBaseUrl: () => "http://localhost:3000",
  isSafeUrl: vi.fn().mockResolvedValue(true),
  safeLookup: vi.fn(),
}));

// Import mocks to manipulate them
import fetch from "node-fetch";
import * as authService from "../../src/services/authService.js";
import streamManager from "../../src/services/streamManager.js";
import db from "../../src/database/db.js";

describe("MPD Proxy SSRF Vulnerability", () => {
  let req, res;

  beforeEach(() => {
    vi.clearAllMocks();

    req = {
      params: {
        username: "user",
        password: "pass",
        stream_id: "1",
        0: "", // relativePath
      },
      query: {},
      headers: {},
      ip: "127.0.0.1",
      on: vi.fn(),
    };

    res = {
      sendStatus: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      setHeader: vi.fn(),
      headersSent: false,
    };

    // Mock Auth
    authService.getXtreamUser.mockResolvedValue({
      id: 1,
      username: "user",
      password: "encrypted_pass",
      is_share_guest: false,
    });

    // Mock DB for getChannel
    const mockChannel = {
      user_channel_id: 1,
      provider_channel_id: 100,
      name: "Test Channel",
      metadata: JSON.stringify({
        original_url: "http://legit.com/live/manifest.mpd",
      }),
      provider_url: "http://provider.com",
      provider_user: "puser",
      provider_pass: "ppass",
      backup_urls: null,
      user_agent: "TestAgent",
    };

    const mockStmt = {
      get: vi.fn().mockReturnValue(mockChannel),
      run: vi.fn(),
    };
    db.prepare.mockReturnValue(mockStmt);

    // Mock Stream Manager
    streamManager.add = vi.fn();
    streamManager.remove = vi.fn();

    // Mock Fetch Response
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "video/mp4" },
      body: {
        pipe: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
      },
    });
  });

  it("should fetch from legit URL when relative path is valid", async () => {
    req.params[0] = "segment.m4s";

    await proxyMpd(req, res);

    expect(fetch).toHaveBeenCalled();
    const calledUrl = fetch.mock.calls[0][0];
    expect(calledUrl).toBe("http://legit.com/live/segment.m4s");
  });

  it("should NOT fetch from arbitrary domain via protocol-relative URL", async () => {
    // Vulnerability: If relativePath starts with //, new URL() changes the host
    req.params[0] = "//evil.com/hack";

    await proxyMpd(req, res);

    // If vulnerable, it fetches http://evil.com/hack
    // If fixed, it should return 400 or fetch from http://legit.com/live/... (which is impossible for //)

    if (fetch.mock.calls.length > 0) {
      const calledUrl = fetch.mock.calls[0][0];
      // If it fetched evil.com, vulnerability exists!
      if (calledUrl === "http://evil.com/hack") {
        console.log("VULNERABILITY CONFIRMED: Fetched http://evil.com/hack");
      }
      expect(calledUrl).not.toBe("http://evil.com/hack");
    } else {
      // It didn't fetch, meaning it was blocked
      // The fix uses res.status(400).send(...), so check status call
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it("should NOT fetch from arbitrary domain via absolute URL", async () => {
    req.params[0] = "http://evil.com/hack";

    await proxyMpd(req, res);

    if (fetch.mock.calls.length > 0) {
      const calledUrl = fetch.mock.calls[0][0];
      if (calledUrl === "http://evil.com/hack") {
        console.log("VULNERABILITY CONFIRMED: Fetched http://evil.com/hack");
      }
      expect(calledUrl).not.toBe("http://evil.com/hack");
    } else {
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it("should NOT fetch from arbitrary domain via whitespace-padded absolute URL", async () => {
    req.params[0] = "   http://evil.com/hack";

    await proxyMpd(req, res);

    if (fetch.mock.calls.length > 0) {
      const calledUrl = fetch.mock.calls[0][0];
      if (calledUrl.includes("evil.com")) {
        console.log(
          "VULNERABILITY CONFIRMED: Fetched http://evil.com/hack via whitespace bypass",
        );
      }
      expect(calledUrl).not.toContain("evil.com");
    } else {
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });
});
