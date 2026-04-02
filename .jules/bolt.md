## 2024-05-18 - [V8 GC Pressure in Large Iteration Loops]
**Learning:** Calling `encodeURIComponent()` and interpolating complex ES6 template literals inside SQLite `.iterate()` loops that process 50,000+ rows causes massive CPU spikes and V8 Garbage Collection pressure. This was identified when examining `xtreamController.js` playlist generation endpoints.
**Action:** Always hoist constant value string operations (like encoding credentials or building base URL prefixes) outside of massive data processing loops. Pre-construct the URL prefix string and use simple string concatenation inside the loop (`+`) instead of template literals (`${}`) to significantly boost performance.## 2026-04-01 - [SQLite Performance: Replace .all().map() with .iterate()]
**Learning:** When rendering huge payloads in SQLite endpoints (like  generating tens of thousands of channel entries), chaining  to fetch all rows into a massive array followed by  duplicates memory allocations and causes V8 GC pressure.
**Action:** Always use  in a  loop to stream rows natively from  when handling massive datasets, pushing directly to the final payload array.

## 2024-05-18 - [SQLite Performance: Replace .all().map() with .iterate()]
**Learning:** When rendering huge payloads in SQLite endpoints (like xtreamController.js generating tens of thousands of channel entries), chaining .all() to fetch all rows into a massive array followed by .map() duplicates memory allocations and causes V8 GC pressure.
**Action:** Always use stmt.iterate() in a for...of loop to stream rows natively from better-sqlite3 when handling massive datasets, pushing directly to the final payload array.
