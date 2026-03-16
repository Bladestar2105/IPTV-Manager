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
