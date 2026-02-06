# 🔍 Full Code Review — IPTV-Manager

**Reviewer:** Automated Code Audit  
**Branch:** `code-review/full-audit`  
**Scope:** Security, bugs, missing functions, translations, UI problems, architecture

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [CRITICAL — Security Vulnerabilities](#2-critical--security-vulnerabilities)
3. [HIGH — Bugs &amp; Missing Functions](#3-high--bugs--missing-functions)
4. [MEDIUM — Logic Errors &amp; Data Integrity](#4-medium--logic-errors--data-integrity)
5. [LOW — UI/UX Problems](#5-low--uiux-problems)
6. [Translation / i18n Issues](#6-translation--i18n-issues)
7. [Architecture &amp; Code Quality](#7-architecture--code-quality)
8. [Recommendations Summary](#8-recommendations-summary)

---

## 1. Executive Summary

The IPTV-Manager is a Node.js/Express application with SQLite (better-sqlite3), cluster mode, and a vanilla JS frontend. Overall the codebase is well-structured with good separation of concerns. However, the audit uncovered **several critical security vulnerabilities**, multiple bugs, missing authorization checks, and various UI/translation issues.

**Finding Counts:**

| Severity | Count |
|----------|-------|
| 🔴 CRITICAL | 7 |
| 🟠 HIGH | 12 |
| 🟡 MEDIUM | 14 |
| 🔵 LOW | 10 |

---

## 2. CRITICAL — Security Vulnerabilities

### 2.1 🔴 OTP Secret Stored in Plaintext

**File:** `src/controllers/authController.js` → `verifyOtp()`

```js
db.prepare(`UPDATE ${table} SET otp_secret = ?, otp_enabled = 1 WHERE id = ?`).run(secret, req.user.id);
```

**Problem:** The TOTP secret is stored in plaintext in the database. If the database file is compromised, all 2FA secrets are exposed, allowing an attacker to generate valid OTP codes for every user, completely defeating the purpose of 2FA.

**Fix:** Encrypt the OTP secret using the existing `encrypt()` function before storing, and `decrypt()` when verifying.

---

### 2.2 🔴 Plaintext Passwords Exposed via API

**File:** `src/controllers/userController.js` → `getUsers()`

```js
const result = users.map(u => {
    let plain = null;
    if (u.password &amp;&amp; !u.password.startsWith('$2b$')) {
        plain = decrypt(u.password);
    }
    return {
        id: u.id,
        username: u.username,
        is_active: u.is_active,
        webui_access: u.webui_access,
        plain_password: plain  // PLAINTEXT PASSWORD SENT TO FRONTEND
    };
});
```

**Problem:** The API endpoint `/api/users` returns decrypted plaintext passwords to the frontend. Even though this is admin-only, it violates the principle of least privilege. If an admin session is hijacked (XSS, token theft), all user passwords are immediately exposed.

**Fix:** Never return passwords to the frontend. If admins need to see/copy passwords, implement a separate endpoint with additional confirmation or show them only once at creation time.

---

### 2.3 🔴 Export Endpoint Leaks Password via GET Query Parameter

**File:** `src/controllers/systemController.js` → `exportData()`

```js
const { user_id, password } = req.query;  // Password in URL!
```

**Problem:** The encryption password for the export is passed as a GET query parameter. GET parameters are:
- Logged in server access logs (Morgan is active)
- Stored in browser history
- Visible in proxy/CDN logs
- Potentially cached

**Fix:** Change to POST request with the password in the request body.

---

### 2.4 🔴 Missing SSRF Protection on Multiple Stream Proxy Endpoints

**File:** `src/controllers/streamController.js`

**Problem:** The `proxyLive`, `proxyMovie`, `proxySeries`, and `proxyTimeshift` functions construct URLs from database values and fetch them **without** calling `isSafeUrl()`. Only `proxyMpd` and `proxySegment` have SSRF protection.

**Affected functions:**
- `proxyLive()` — no `isSafeUrl()` check
- `proxyMovie()` — no `isSafeUrl()` check
- `proxySeries()` — no `isSafeUrl()` check
- `proxyTimeshift()` — no `isSafeUrl()` check

**Also missing SSRF checks:**
- `src/controllers/epgController.js` → `triggerUpdateEpgSource()` — fetches `provider.epg_url` without check
- `src/controllers/epgController.js` → `updateAllEpgSources()` — same issue
- `src/services/schedulerService.js` → `startEpgScheduler()` — fetches `provider.epg_url` without check
- `src/services/epgService.js` → `updateEpgSource()` — fetches `source.url` without check

**Fix:** Add `isSafeUrl()` checks before all upstream fetches, consistent with `proxyMpd()` and `proxySegment()`.

---

### 2.5 🔴 Client Log Endpoint Has No Rate Limiting or Authentication

**File:** `src/routes/system.js`

```js
router.post('/client-logs', systemController.createClientLog); // Public - no auth!
```

**Problem:** The `/api/client-logs` POST endpoint is completely unauthenticated and has no rate limiting. An attacker can:
1. **Flood the database** with millions of log entries (DoS via disk exhaustion)
2. **Inject misleading log entries** to confuse administrators

**Fix:** Add rate limiting and optionally authentication:
```js
import { apiLimiter } from '../middleware/security.js';
router.post('/client-logs', apiLimiter, systemController.createClientLog);
```
Also add a maximum log count or automatic cleanup.

---

### 2.6 🔴 Missing Authorization on Several Admin Endpoints

**File:** `src/controllers/systemController.js`

The following endpoints require `authenticateToken` but do **not** check `req.user.is_admin`:

| Endpoint | Function | Issue |
|----------|----------|-------|
| `GET /api/client-logs` | `getClientLogs` | Any authenticated user can read all client logs |
| `DELETE /api/client-logs` | `deleteClientLogs` | Any authenticated user can delete all client logs |
| `GET /api/sync-configs` | `getSyncConfigs` | Any authenticated user can see all sync configs |
| `GET /api/sync-configs/:pid/:uid` | `getSyncConfig` | Any user can read any sync config |
| `POST /api/sync-configs` | `createSyncConfig` | Any user can create sync configs |
| `PUT /api/sync-configs/:id` | `updateSyncConfig` | Any user can modify sync configs |
| `DELETE /api/sync-configs/:id` | `deleteSyncConfig` | Any user can delete sync configs |
| `GET /api/sync-logs` | `getSyncLogs` | Any user can read all sync logs |
| `PUT /api/category-mappings/:id` | `updateCategoryMapping` | Any user can modify any mapping |

**Fix:** Add admin checks to all these endpoints:
```js
if (!req.user.is_admin) return res.status(403).json({error: 'Access denied'});
```

---

### 2.7 🔴 Arbitrary Header Injection via Segment Proxy

**File:** `src/controllers/streamController.js` → `proxySegment()`

```js
if (req.query.data) {
    const payload = JSON.parse(Buffer.from(req.query.data, 'base64').toString());
    if (payload.u) targetUrl = payload.u;
    if (payload.h) Object.assign(headers, payload.h);  // Arbitrary headers!
}
```

**Problem:** While there IS an `isSafeUrl()` check on the URL, the `payload.h` allows injection of **arbitrary HTTP headers** into the upstream request. This could be used for:
- Header injection attacks
- Overriding security headers like `Host`
- SSRF via `Host` header manipulation

**Fix:** Whitelist allowed headers:
```js
const ALLOWED_HEADERS = ['User-Agent', 'Referer', 'Cookie', 'Connection'];
if (payload.h) {
    for (const [key, val] of Object.entries(payload.h)) {
        if (ALLOWED_HEADERS.includes(key)) headers[key] = val;
    }
}
```

---

## 3. HIGH — Bugs &amp; Missing Functions

### 3.1 🟠 `getEpgNow()` Returns Empty Array — Dead Function

**File:** `src/controllers/epgController.js`

```js
export const getEpgNow = (req, res) => {
  res.json([]);  // Always returns empty!
};
```

**Problem:** The EPG "Now Playing" endpoint is registered at `GET /api/epg/now` but always returns an empty array. This is a stub that was never implemented. Any UI feature relying on "currently playing" EPG data will never work.

**Fix:** Implement the function to return currently airing programs by querying the EPG data for programs where `start <= now <= stop`.

---

### 3.2 🟠 Race Condition: `createDefaultAdmin()` Not Awaited

**File:** `src/server.js`

```js
if (cluster.isPrimary) {
  initDb(true);
  createDefaultAdmin();  // BUG: async function not awaited!
  // ... immediately forks workers
}
```

**Problem:** `createDefaultAdmin()` is an `async` function but is **not awaited**. Workers may start before the admin user is created, leading to a race condition where the first login attempt fails because the admin doesn't exist yet.

**Fix:** Wrap the primary block in an async IIFE and await the function:
```js
(async () => {
  initDb(true);
  await createDefaultAdmin();
  // Then fork workers...
})();
```

---

### 3.3 🟠 Stream Manager Initialization Race Condition

**File:** `src/server.js`

```js
if (process.env.REDIS_URL) {
  (async () => {
    // ... Redis init ...
    streamManager.init(db, redisClient);
  })();  // Not awaited!
} else {
  streamManager.init(db, null);
}
```

**Problem:** When Redis is configured, the stream manager initialization is in an async IIFE that is **not awaited**. Workers start listening for HTTP requests before the stream manager is initialized. The first few requests may hit an uninitialized stream manager (where `this.db` and `this.redis` are both `null`).

**Fix:** Await the initialization before starting the HTTP server.

---

### 3.4 🟠 `deleteProvider` Doesn't Clean Up `user_channels` or `epg_channel_mappings`

**File:** `src/controllers/providerController.js` → `deleteProvider()`

```js
db.transaction(() => {
    db.prepare('DELETE FROM provider_channels WHERE provider_id = ?').run(id);
    // MISSING: user_channels referencing deleted provider_channels
    // MISSING: epg_channel_mappings referencing deleted provider_channels
    // MISSING: stream_stats referencing deleted provider_channels
    db.prepare('DELETE FROM sync_configs WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM sync_logs WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM category_mappings WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
})();
```

**Problem:** When a provider is deleted, its `provider_channels` are deleted, but:
1. `user_channels` referencing those provider channels are NOT deleted → orphaned entries
2. `epg_channel_mappings` referencing those channels are NOT deleted → orphaned entries
3. `stream_stats` referencing those channels are NOT deleted → foreign key violations

**Fix:** Add cleanup before deleting provider_channels:
```js
const channelIds = db.prepare('SELECT id FROM provider_channels WHERE provider_id = ?').all(id).map(c => c.id);
if (channelIds.length > 0) {
    const placeholders = channelIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM user_channels WHERE provider_channel_id IN (${placeholders})`).run(...channelIds);
    db.prepare(`DELETE FROM epg_channel_mappings WHERE provider_channel_id IN (${placeholders})`).run(...channelIds);
    db.prepare(`DELETE FROM stream_stats WHERE channel_id IN (${placeholders})`).run(...channelIds);
}
```

---

### 3.5 🟠 `deleteUser` Doesn't Clean Up `epg_channel_mappings` or `stream_stats`

**File:** `src/controllers/userController.js` → `deleteUser()`

Same issue as 3.4 — when deleting a user, `epg_channel_mappings` and `stream_stats` for that user's provider channels are not cleaned up.

---

### 3.6 🟠 Missing `category_type` in Import Data Migration

**File:** `src/controllers/systemController.js` → `importData()`

```js
db.prepare(`
    INSERT INTO category_mappings (provider_id, user_id, provider_category_id, provider_category_name, user_category_id, auto_created)
    VALUES (?, ?, ?, ?, ?, ?)
`).run(newProvId, newUserId, m.provider_category_id, m.provider_category_name, newUserCatId, m.auto_created);
```

**Problem:** The import function does NOT include the `category_type` column when inserting category mappings. The table has a UNIQUE constraint on `(provider_id, user_id, provider_category_id, category_type)`, so all imported mappings will default to `'live'`, potentially causing:
- Loss of movie/series category type information
- UNIQUE constraint violations for duplicate categories

**Fix:** Include `category_type` in the INSERT:
```js
db.prepare(`
    INSERT INTO category_mappings (..., category_type) VALUES (..., ?)
`).run(..., m.category_type || 'live');
```

---

### 3.7 🟠 Xtream `server_info.port` is Hardcoded to 3000

**File:** `src/controllers/xtreamController.js` → `playerApi()`

```js
server_info: {
    url: req.hostname,
    port: '3000',  // Hardcoded!
    https_port: '',
    server_protocol: 'http',
```

**Problem:** The port is hardcoded to `3000` instead of using the configured `PORT` constant or detecting from the request. When running behind a reverse proxy on port 80/443, IPTV clients will try to connect to port 3000 and fail.

**Fix:**
```js
import { PORT } from '../config/constants.js';
// ...
port: String(PORT),
server_protocol: req.secure ? 'https' : 'http',
```

---

### 3.8 🟠 `isSafeUrl` Doesn't Block IPv6 Private Ranges Properly

**File:** `src/utils/helpers.js` → `isSafeUrl()`

```js
} else if (ipVer === 6) {
    if (address === '::1' || address.includes('::ffff:')) return false;
}
```

**Problem:** The IPv6 check only blocks `::1` (loopback) and IPv4-mapped addresses (`::ffff:`). It does NOT block:
- `fe80::/10` — link-local addresses
- `fc00::/7` — unique local addresses (private)
- `fd00::/8` — unique local addresses

**Fix:** Add comprehensive IPv6 private range checks:
```js
if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return false;
```

---

### 3.9 🟠 Authentication Cache Leaks Full User Objects Including Passwords

**File:** `src/services/authService.js` → `authUser()`

```js
authCache.set(cacheKey, {
    user: user,  // Full DB row including password hash!
    expiry: Date.now() + AUTH_CACHE_TTL
});
```

**Problem:** The entire user database row (including the password field) is cached in memory and returned to callers. The password hash/encrypted password is passed around unnecessarily.

**Fix:** Strip sensitive fields before caching:
```js
const { password, otp_secret, ...safeUser } = user;
authCache.set(cacheKey, { user: { ...safeUser, id: user.id }, expiry: ... });
```

---

### 3.10 🟠 `getPlaylist` M3U Output Only Includes Live Channels

**File:** `src/controllers/xtreamController.js` → `getPlaylist()`

```js
const rows = db.prepare(`
    SELECT uc.id as user_channel_id, pc.name, pc.logo, pc.epg_channel_id,
           cat.name as category_name, map.epg_channel_id as manual_epg_id
    FROM user_channels uc
    JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    JOIN user_categories cat ON cat.id = uc.user_category_id
    LEFT JOIN epg_channel_mappings map ON map.provider_channel_id = pc.id
    WHERE cat.user_id = ?
    ORDER BY uc.sort_order
`).all(user.id);
```

**Problem:** The `get.php` playlist endpoint fetches ALL channels (live, movie, series) but generates stream URLs using only the `/live/` path format. Movies and series will have incorrect URLs.

**Fix:** Check `pc.stream_type` and generate appropriate URLs for each type (live, movie, series).

---

### 3.11 🟠 Multer Upload Has No File Size Limit or Type Validation

**File:** `src/middleware/upload.js`

```js
export const upload = multer({ dest: uploadDir });
```

**Problem:** The multer configuration has no file size limit, no file type validation, and no filename sanitization. An attacker could:
1. Upload extremely large files to exhaust disk space
2. Upload files with malicious names (path traversal)

**Fix:**
```js
export const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/octet-stream') cb(null, true);
        else cb(new Error('Invalid file type'));
    }
});
```

---

### 3.12 🟠 JWT Secret File Permissions Not Set

**File:** `src/utils/crypto.js`

```js
JWT_SECRET = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(jwtFile, JWT_SECRET);  // Default permissions (0644)
```

**Problem:** The JWT secret and encryption key files are written with default permissions (typically `0644`), meaning any user on the system can read them.

**Fix:** Set restrictive file permissions:
```js
fs.writeFileSync(jwtFile, JWT_SECRET, { mode: 0o600 });
fs.writeFileSync(keyFile, ENCRYPTION_KEY, { mode: 0o600 });
```

---

## 4. MEDIUM — Logic Errors &amp; Data Integrity

### 4.1 🟡 `migrateProviderPasswords` Detection Logic is Flawed

**File:** `src/database/migrations.js` → `migrateProviderPasswords()`

```js
if (p.password.includes(':')) {
    const val = decrypt(p.password);
    if (val !== p.password) continue; // Assumes already encrypted
}
```

**Problem:** A plaintext password containing `:` (e.g., `my:password123`) would be treated as already encrypted. The `decrypt()` function would fail and return the original text, so `val === p.password` would be true, and the password would be encrypted. However, this is fragile and confusing logic.

**Fix:** Use a more reliable detection method:
```js
if (/^[0-9a-f]{32}:[0-9a-f]+$/i.test(p.password)) continue; // Already encrypted
```

---

### 4.2 🟡 `decrypt()` Silently Returns Original Text on Failure

**File:** `src/utils/crypto.js`

```js
export function decrypt(text) {
    // ...
    catch (e) {
        return text; // Returns original on failure!
    }
}
```

**Problem:** When decryption fails, the function silently returns the original text. This makes it impossible to distinguish between "decryption failed" and "was already plaintext". This can mask bugs and data corruption.

**Fix:** Consider returning a sentinel value or throwing an error with a specific type that callers can catch.

---

### 4.3 🟡 CORS Allows All Origins by Default

**File:** `src/app.js`

```js
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS || '*',
    credentials: true
}));
```

**Problem:** By default, CORS allows ALL origins (`*`) with `credentials: true`. While browsers block credentialed requests with `origin: *`, this is a security misconfiguration that should be addressed.

**Fix:** Default to a restrictive origin or at least document the requirement to set `ALLOWED_ORIGINS` in production.

---

### 4.4 🟡 Scheduler Intervals Leak on Worker Restart

**File:** `src/services/schedulerService.js` → `startSyncScheduler()`

```js
let syncIntervals = new Map();

export function startSyncScheduler() {
  syncIntervals.forEach(interval => clearInterval(interval));
  syncIntervals.clear();
  // ... creates new intervals
}
```

**Problem:** `startSyncScheduler()` is called from `server.js` in the worker process, and also called from `createSyncConfig()` and `updateSyncConfig()`. Each call clears and recreates all intervals. However, if a worker crashes and restarts, the old intervals are lost (they were in the crashed process's memory), and the new worker creates fresh ones. This is correct behavior, but the issue is that `startSyncScheduler()` is called from API endpoints which means **any** sync config change restarts **all** schedulers, potentially causing missed sync windows.

---

### 4.5 🟡 `checkIsAdultColumn` Migration Uses Try/Catch for Flow Control

**File:** `src/database/migrations.js`

```js
export function checkIsAdultColumn(db) {
    try {
        db.exec('ALTER TABLE user_categories ADD COLUMN is_adult INTEGER DEFAULT 0');
        console.log('✅ DB Migration: is_adult column added');
    } catch (e) {
        // Column already exists — silently ignored
    }
}
```

**Problem:** Using try/catch for flow control is an anti-pattern. This should check if the column exists first, like the other migration functions do.

---

### 4.6 🟡 `proxyLive` M3U8 Rewriting Exposes Credentials in URLs

**File:** `src/controllers/streamController.js` → `proxyLive()`

```js
const newText = text.replace(/^(?!#)(.+)$/gm, (match) => {
    // ...
    return `/live/segment/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/seg.ts?data=${encodeURIComponent(b64)}${tokenParam}`;
});
```

**Problem:** When rewriting M3U8 playlists, the segment URLs include the username and password in the URL path. While these are the Xtream credentials (not admin credentials), they are visible in browser network tabs, logs, and potentially cached.

---

### 4.7 🟡 `proxyMpd` BaseURL Rewriting Exposes Credentials

**File:** `src/controllers/streamController.js` → `proxyMpd()`

```js
const baseUrl = `${req.protocol}://${req.get('host')}/live/mpd/${encodeURIComponent(req.params.username)}/${encodeURIComponent(req.params.password)}/${streamId}/`;
newText = newText.replace(/<BaseURL>http[^<]+<\/BaseURL>/g, `<BaseURL>${baseUrl}</BaseURL>`);
```

Same issue as 4.6 — credentials in URLs.

---

### 4.8 🟡 No Input Validation on `blockIp` — Can Block Invalid IPs

**File:** `src/controllers/systemController.js` → `blockIp()`

```js
const { ip, reason, duration } = req.body;
if (!ip) return res.status(400).json({error: 'ip required'});
// No validation that 'ip' is actually a valid IP address!
```

**Problem:** The IP address is not validated. An admin could accidentally block invalid strings, or an attacker with admin access could insert SQL-like strings (though parameterized queries prevent injection).

**Fix:** Validate the IP format:
```js
import { isIP } from 'net';
if (!ip || isIP(ip) === 0) return res.status(400).json({error: 'Valid IP required'});
```

---

### 4.9 🟡 `unblockIp` Uses String Detection for ID vs IP

**File:** `src/controllers/systemController.js` → `unblockIp()`

```js
if (id.includes('.') || id.includes(':')) {
    // Treat as IP address
} else {
    // Treat as database ID
}
```

**Problem:** This heuristic is fragile. An IPv4 address always contains `.`, and an IPv6 address contains `:`, but a numeric database ID could theoretically conflict with certain inputs.

---

### 4.10 🟡 `getProviderCategories` Leaks Decrypted Password

**File:** `src/controllers/providerController.js` → `getProviderCategories()`

```js
provider.password = decrypt(provider.password);
const authParams = `username=${encodeURIComponent(provider.username)}&amp;password=${encodeURIComponent(provider.password)}`;
const apiUrl = `${baseUrl}/player_api.php?${authParams}&amp;action=${action}`;
const resp = await fetch(apiUrl);
```

**Problem:** The decrypted password is assigned back to the `provider` object and embedded in a URL string. If this URL is logged (e.g., by an error handler), the password is exposed.

**Fix:** Use a local variable instead of mutating the provider object.

---

### 4.11 🟡 Security Log Retention — No Automatic Cleanup

**File:** `src/services/schedulerService.js` → `startCleanupScheduler()`

```js
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    const retention = 7 * 86400;
    db.prepare('DELETE FROM client_logs WHERE timestamp < ?').run(now - retention);
}, 3600000);
```

**Problem:** Only `client_logs` are cleaned up. `security_logs` and `blocked_ips` (expired entries) are never automatically cleaned, leading to unbounded database growth.

**Fix:** Add cleanup for security_logs and expired blocked_ips:
```js
db.prepare('DELETE FROM security_logs WHERE timestamp < ?').run(now - retention);
db.prepare('DELETE FROM blocked_ips WHERE expires_at < ?').run(now);
```

---

### 4.12 🟡 `authLimiter` Threshold is Too High (100 attempts in 15 min)

**File:** `src/middleware/security.js`

```js
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,  // 100 login attempts per 15 minutes!
```

**Problem:** 100 login attempts in 15 minutes is very generous for an authentication endpoint. This allows significant brute-force attempts before rate limiting kicks in.

**Fix:** Reduce to 10-20 attempts per 15 minutes:
```js
max: 15,
```

---

### 4.13 🟡 `apiLimiter` Applied Only to `/api` Routes — Xtream Routes Unprotected

**File:** `src/app.js`

```js
app.use('/api', apiLimiter);
// ...
app.use('/', streamRoutes);   // No rate limiting!
app.use('/', xtreamRoutes);   // No rate limiting!
```

**Problem:** The API rate limiter only applies to `/api` routes. The Xtream API routes (`/player_api.php`, `/get.php`, `/xmltv.php`) and stream routes (`/live/`, `/movie/`, `/series/`) have NO rate limiting. An attacker can make unlimited requests to these endpoints.

---

### 4.14 🟡 `DATA_DIR` Defaults to Project Root

**File:** `src/config/constants.js`

```js
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../');
```

**Problem:** If `DATA_DIR` is not set, it defaults to the project root directory. This means the SQLite database, JWT secret, encryption key, and cache files are stored alongside the source code. In a Docker deployment this is fine, but in a bare-metal deployment this could expose sensitive files via the static file server.

---

## 5. LOW — UI/UX Problems

### 5.1 🔵 CSP Allows `unsafe-inline` and `unsafe-eval`

**File:** `src/middleware/security.js`

```js
scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
scriptSrcAttr: ["'unsafe-inline'"],
styleSrc: ["'self'", "'unsafe-inline'"],
```

**Problem:** The Content Security Policy allows `unsafe-inline` and `unsafe-eval` for scripts, which significantly weakens XSS protection. This is likely needed because the frontend uses inline event handlers and `eval()`-like patterns.

**Fix:** Refactor the frontend to use external scripts and event listeners, then remove `unsafe-inline` and `unsafe-eval`.

---

### 5.2 🔵 No CSRF Protection

**Problem:** The application uses JWT tokens in the Authorization header, which provides some CSRF protection (since cookies aren't used for auth). However, the `cors` middleware with `credentials: true` and `origin: '*'` could allow cross-origin requests in certain configurations.

---

### 5.3 🔵 No Pagination on Security Logs, Blocked IPs, Whitelist

**File:** `src/controllers/systemController.js`

The `getSecurityLogs`, `getBlockedIps`, and `getWhitelist` endpoints return all records with only an optional `limit` parameter. For large deployments, this could return thousands of records, causing slow page loads.

---

### 5.4 🔵 `player.html` — No Error Handling for Missing HLS/MPEGTS Libraries

**File:** `public/player.html`

The web player loads `hls.min.js` and `mpegts.min.js` from the vendor directory but has no fallback if these files fail to load. The player will silently fail.

---

### 5.5 🔵 No Loading Indicators for Long Operations

Several UI operations (sync, EPG update, import/export) can take minutes but the UI only shows a brief "Syncing..." text. There's no progress bar or detailed status updates.

---

### 5.6 🔵 `index.html` — Missing `meta viewport` for Mobile

**File:** `public/index.html`

The HTML file should include a viewport meta tag for proper mobile rendering. While Bootstrap handles responsive design, the viewport tag is essential.

---

### 5.7 🔵 No Confirmation Before Destructive Bulk Operations

The bulk delete operations for categories and channels use `confirm()` dialogs, but the message doesn't list what will be deleted. Users could accidentally delete important data.

---

### 5.8 🔵 `style.css` — No Dark Mode Support

The application only has a light theme. Many IPTV management tools are used in low-light environments where a dark mode would be beneficial.

---

### 5.9 🔵 Web Player — No Volume Control Persistence

**File:** `public/player.html`

The web player doesn't persist volume settings between sessions. Each time a user opens the player, volume resets to default.

---

### 5.10 🔵 No Favicon for Player Page

**File:** `public/player.html`

The player page doesn't reference the favicon, causing 404 errors in the browser console.

---

## 6. Translation / i18n Issues

### 6.1 Missing Translation Keys

The following keys are used in the code but missing from one or more language files:

| Key | Missing In | Used In |
|-----|-----------|---------|
| `access_denied_webui` | en, de, fr, el | `authController.js` login error |
| `invalid_otp` | en, de, fr, el | `authController.js` OTP error |
| `server_error` | en, de, fr, el | `authController.js` catch block |
| `user_not_found` | en, de, fr, el | `authController.js` change password |
| `username_taken` | en, de, fr, el | `userController.js` update user |
| `invalid_username_format` | en, de, fr, el | `userController.js` create user |
| `invalid_username_length` | en, de, fr, el | `userController.js` create/update user |

### 6.2 Greek (el) Translation is Incomplete

The Greek translation is missing several keys that exist in English, German, and French:

- `authentication_required` — present but many player-related keys may be missing
- Several keys in the `el` locale appear to be direct copies from English rather than actual Greek translations

### 6.3 Hardcoded English Strings in Backend

Several backend error messages are hardcoded in English and not translatable:

- `'Access denied'` — used in multiple controllers
- `'missing fields'` — providerController
- `'provider not found'` — providerController
- `'user_id required'` — providerController
- `'name and url required'` — epgController
- `'no fields to update'` — epgController

These should use error codes that the frontend can translate.

### 6.4 `i18n.js` — No Fallback Chain

```js
function t(key, replacements = {}) {
  let text = translations[currentLang][key] || translations['en'][key] || key;
```

**Problem:** If a key is missing in both the current language AND English, the raw key is returned (e.g., `access_denied_webui`). This is visible to users and looks like a bug.

**Fix:** Add a warning in development mode and return a more user-friendly fallback.

---

## 7. Architecture &amp; Code Quality

### 7.1 SQLite in Cluster Mode

The application uses Node.js `cluster` to fork multiple workers, all sharing the same SQLite database file. While WAL mode helps, SQLite is not designed for high-concurrency multi-process writes. Consider:
- Using Redis for all shared state (not just optionally for streams)
- Using a single-writer pattern
- Switching to PostgreSQL for production deployments

### 7.2 No Input Validation Library

Input validation is done manually throughout the codebase with inconsistent patterns. Consider using a validation library like `joi`, `zod`, or `express-validator` for consistent, declarative validation.

### 7.3 No Test Suite

The project has no automated tests. The `scripts/` directory contains some manual verification scripts but no unit or integration tests. This makes refactoring risky and bugs harder to catch.

### 7.4 No Health Check Endpoint

There's no `/health` or `/api/health` endpoint for monitoring. This is important for Docker deployments and load balancers.

### 7.5 Error Handling Inconsistency

Some controllers return `{error: e.message}` (exposing internal error details), while others return generic messages. Internal error messages should never be exposed to clients in production.

### 7.6 No Request Body Size Limit

**File:** `src/app.js`

```js
app.use(bodyParser.json());
```

The JSON body parser has no size limit configured. An attacker could send extremely large JSON payloads to exhaust memory.

**Fix:**
```js
app.use(bodyParser.json({ limit: '1mb' }));
```

### 7.7 Morgan Logging in Production

Morgan logs every request to stdout. In production with high traffic, this generates enormous log volumes. Consider using a conditional logging setup.

---

## 8. Recommendations Summary

### Immediate Actions (Critical)
1. **Encrypt OTP secrets** before storing in database
2. **Remove plaintext passwords** from the `/api/users` response
3. **Change export endpoint** from GET to POST for password handling
4. **Add `isSafeUrl()` checks** to all stream proxy functions and EPG fetchers
5. **Add rate limiting** to the client-logs endpoint
6. **Add admin authorization checks** to all admin-only endpoints
7. **Whitelist headers** in the segment proxy instead of blindly merging

### Short-term Actions (High)
8. Implement `getEpgNow()` function
9. Fix `createDefaultAdmin()` race condition (await it)
10. Fix `deleteProvider` and `deleteUser` cascade cleanup
11. Add `category_type` to import data migration
12. Fix hardcoded Xtream port
13. Add file size limits to multer upload
14. Set restrictive permissions on secret files

### Medium-term Actions
15. Add comprehensive IPv6 private range blocking
16. Implement automatic cleanup for security_logs
17. Reduce auth rate limiter threshold
18. Add rate limiting to Xtream/stream routes
19. Add request body size limits
20. Add a health check endpoint
21. Complete missing translation keys

### Long-term Actions
22. Add automated test suite
23. Consider PostgreSQL for production
24. Implement proper CSP without unsafe-inline/unsafe-eval
25. Add dark mode support
26. Add input validation library