## 2025-02-01 - Memory Bottleneck in XML Parsing
**Learning:** Loading entire XML files into memory via `fs.readFile` and using regex on the full string causes massive memory usage (3x file size or more) and can crash the process for large files (e.g. EPGs).
**Action:** Always use streaming parsers (like `fs.createReadStream` + `readline`) for processing large files line-by-line to keep memory footprint constant.

## 2025-05-22 - Regex Loop vs match().forEach()
**Learning:** Using `while ((match = regex.exec(str)) !== null)` is significantly faster (~6x) than `str.match(regex).forEach()` when parsing attributes because it avoids creating intermediate arrays and strings via `split`, `slice`, `join`, and `replace`. Capture groups are powerful.
**Action:** Always prefer `exec` loop with capture groups for parsing repeating patterns in strings, especially in hot paths like playlist parsing.
