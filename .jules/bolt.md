## 2026-03-09 - SQLite Grouping & Ordering Optimization
**Learning:** Using `ORDER BY X ASC, Y ASC` explicitly can eliminate multiple temporary B-trees in SQLite if a composite index exists on `(X, Y)`, completely skipping both sorting AND grouping passes when combined with grouping/aggregate functions like `json_group_array`.
**Action:** Always verify `EXPLAIN QUERY PLAN` when utilizing `GROUP BY` and ensure the inner `ORDER BY` mirrors existing composite indices.

## 2026-03-09 - Memory Update Regression
**Learning:** Overwriting memory files completely deletes previous learning entries which acts as the agent's memory.
**Action:** Always append (`>>`) or use specific tools to edit memory files rather than overwriting (`>`) to ensure past learnings are preserved.
## 2026-03-10 - Array to Set Serialization Trap
**Learning:** Replacing an Array with a Set on a cached user model (e.g., `user.allowed_channels`) breaks JSON serialization because Sets stringify to empty objects (`{}`). This crashes downstream consumers that expect array methods.
**Action:** Keep shared data models as Arrays for safe serialization. If Set lookups are needed for performance, convert the array to a local Set only within the specific function scope where the lookup occurs.
## 2026-03-10 - Expensive Substring Checks in Hot Loops
**Learning:** Using `String.prototype.includes()` checks (e.g., `streamUrl.includes('/movie/')`) repeatedly inside hot loops containing tens of thousands of items causes a measurable performance bottleneck.
**Action:** Replace URL/string-based inference with direct property equality checks (`ch.stream_type === 'movie'`) mapped directly from the database schema to ensure O(1) performance.

## 2026-03-10 - Generator Stream Buffering for XMLTV
**Learning:** Returning thousands of small string fragments (like individual XML elements) from an `async function*` generator and passing them directly to `res.write()` introduces massive network stack overhead and event loop blocking, drastically reducing throughput.
**Action:** Implement string buffering directly inside the generator function, accumulating smaller yields into larger chunks (e.g., 64KB) before calling `yield`. This minimizes I/O operations and context switching overhead.

## 2026-03-10 - O(1) Memory Streaming for Massive M3U Playlists
**Learning:** Storing massive M3U playlists containing tens of thousands of channel strings inside an array before joining them (`lines.join('\n')`) into a gigantic string at the end of the `playlist` endpoint exhausts V8 heap memory and blocks the event loop.
**Action:** When dynamically generating M3U or large text payloads, use string buffers and stream them incrementally using `res.write(buffer)` instead of accumulating everything into memory to maintain a low memory footprint.

## 2026-03-17 - SQLite Rate Limiting Query Optimization
**Learning:** Querying log tables (like `security_logs`) without proper indices for rate-limiting operations (e.g., checking failed logins) can result in continuous full table scans. During brute-force attacks or frequent automated scans, this degrades performance exponentially, consuming vast amounts of CPU and blocking the event loop since SQLite operates synchronously in the Node thread.
**Action:** Always ensure that time-series log tables queried for rate-limiting or aggregate analysis have composite indices matching the primary access patterns, typically `(identifier, timestamp)` or `(timestamp)` depending on whether queries filter by specific entities.

## 2026-03-19 - SQLite Temp B-Trees on Ordered Filtering
**Learning:** Filtering and then ordering a large dataset in SQLite (e.g., `WHERE provider_id = ? ORDER BY original_sort_order ASC, name ASC`) will force the engine to allocate a temporary B-tree for the sort pass if the used index does not cover the sorting columns sequentially after the filtered ones. For datasets with millions of rows, this results in O(N log N) overhead per query instead of O(N) linear read.
**Action:** When filtering by `A` and `B` and ordering by `C` and `D`, create a strict composite index `(A, B, C, D)` to allow SQLite to walk the B-tree sequentially without additional memory allocation or sorting passes.
## 2026-03-10 - Regex Fast Path in Hot Loops\n**Learning:** In tight loops processing tens of thousands of channels (like M3U playlist generation), unconditionally executing `replace(/[\r\n]+/g, '')` introduces massive CPU overhead due to regex engine initialization and execution, even if the string doesn't contain the characters.\n**Action:** Use a fast-path check with `String.prototype.indexOf()` to verify the presence of target characters before invoking the regex engine. This can speed up sanitization by ~3x in hot loops.

## 2026-03-20 - SQLite Temp B-Trees on Implicit Ordered Joins
**Learning:** Querying `user_channels` joined with `user_categories` and applying an absolute order using just `ORDER BY uc.sort_order` prevents SQLite from using composite indexes efficiently. Instead, it creates a temporary B-tree for the final order, resulting in O(N log N) overhead for massive channel lists (e.g., M3U generation).
**Action:** For lists naturally scoped by categories, structure the `ORDER BY` clause hierarchically (e.g., `ORDER BY cat.sort_order ASC, uc.sort_order ASC`) to align with existing nested relationships. Then ensure matching composite indexes exist (e.g., `(user_category_id, is_hidden, sort_order)`). This allows SQLite to iterate linearly without creating a Temp B-Tree.

## 2025-05-18 - [SQLite Iterator Optimization]
**Learning:** Returning massive rows from SQLite using `.all()` pushes all resulting JS objects into the V8 heap at once, which blocks the event loop and triggers out-of-memory errors for playlists containing tens of thousands of channels.
**Action:** When dynamically generating large M3U or JSON payloads natively without pagination, always use `stmt.iterate()` to stream the results chunk-by-chunk. This significantly reduces peak memory usage.
