## 2025-02-01 - Memory Bottleneck in XML Parsing
**Learning:** Loading entire XML files into memory via `fs.readFile` and using regex on the full string causes massive memory usage (3x file size or more) and can crash the process for large files (e.g. EPGs).
**Action:** Always use streaming parsers (like `fs.createReadStream` + `readline`) for processing large files line-by-line to keep memory footprint constant.
