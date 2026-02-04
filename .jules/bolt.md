## 2025-02-01 - Memory Bottleneck in XML Parsing
**Learning:** Loading entire XML files into memory via `fs.readFile` and using regex on the full string causes massive memory usage (3x file size or more) and can crash the process for large files (e.g. EPGs).
**Action:** Always use streaming parsers (like `fs.createReadStream` + `readline`) for processing large files line-by-line to keep memory footprint constant.

## 2026-02-04 - Enable Gzip Compression
**Learning:** The application was serving large static assets (100KB+ JS) and API responses (50KB+ JSON) without compression.
**Action:** Added `compression` middleware. Verified ~80% reduction in transfer size for text-based assets.
