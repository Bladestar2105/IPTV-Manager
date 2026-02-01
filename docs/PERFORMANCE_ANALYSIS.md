# Performance Analysis: SQLite vs Redis for Stream Tracking

## Current Architecture (SQLite)
The application currently uses a SQLite table `current_streams` to track active sessions. This enables the multi-process cluster to share state.

### Workload Profile
- **Stream Type:** HLS (HTTP Live Streaming)
- **Behavior:** Clients poll the playlist URL (`.m3u8`) every ~6 seconds.
- **Logic:**
  1.  **Cleanup:** `DELETE FROM current_streams WHERE user_id = ? AND ip = ?` (Enforce single session per IP)
  2.  **Add:** `INSERT OR REPLACE INTO current_streams ...`

### Write Load
For **N** concurrent users:
- **Writes/sec** ≈ (2 * N) / 6
- **100 Users:** ~33 writes/sec
- **1,000 Users:** ~333 writes/sec
- **10,000 Users:** ~3,333 writes/sec

### Bottleneck
SQLite, even in WAL (Write-Ahead Logging) mode, serializes write transactions. On standard SSDs, SQLite can handle 1,000-5,000 writes per second.
- **Limit:** At **~2,000-3,000 concurrent users**, the database write lock may become a bottleneck, causing API latency for all other endpoints (login, EPG, etc.).
- **Latency:** Disk I/O (fsync) is the primary latency factor.

## Proposed Optimization (Redis)
Implementing Redis as an optional backend for `StreamManager`.

### Benefits
1.  **In-Memory Speed:** Redis operations are sub-millisecond and do not block on disk I/O.
2.  **Concurrency:** Redis handles high write throughput (100k+ ops/sec) effortlessly.
3.  **Scalability:** Allows the application to scale to 10k+ users without database locking issues.

### Implementation Strategy
- **Key Structure:**
  - `iptv:streams`: Hash map of `{ connectionId: JSON }`
  - `iptv:user_index:<userId>:<ip>`: String pointing to `connectionId` (Secondary index for fast cleanup)
- **Fallback:** Keep SQLite implementation as the default for ease of use in smaller deployments.

### Conclusion
Implementing Redis is **highly recommended** for high-scale deployments, while SQLite remains sufficient for personal or small-group usage (<500 users).
