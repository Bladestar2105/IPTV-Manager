## 2025-02-01 - Memory Bottleneck in XML Parsing
**Learning:** Loading entire XML files into memory via `fs.readFile` and using regex on the full string causes massive memory usage (3x file size or more) and can crash the process for large files (e.g. EPGs).
**Action:** Always use streaming parsers (like `fs.createReadStream` + `readline`) for processing large files line-by-line to keep memory footprint constant.

## 2025-05-22 - Regex Loop vs match().forEach()
**Learning:** Using `while ((match = regex.exec(str)) !== null)` is significantly faster (~6x) than `str.match(regex).forEach()` when parsing attributes because it avoids creating intermediate arrays and strings via `split`, `slice`, `join`, and `replace`. Capture groups are powerful.
**Action:** Always prefer `exec` loop with capture groups for parsing repeating patterns in strings, especially in hot paths like playlist parsing.

## 2025-06-01 - O(N) Search in Loop
**Learning:** Filtering an array of 10k+ items inside a loop for 10k+ items creates an O(N*M) complexity which is extremely slow. Using a Map index changes lookup to O(1), making the process O(M).
**Action:** Always pre-compute indexes (Maps) for frequently accessed data in matching algorithms.
## 2026-02-13 - [Bit Signature Optimization]
**Learning:** Inverted Indexes (Map<Bigram, List<Channel>>) can be slower than brute force for fuzzy matching when candidate sets are small (< 5000) and bigrams have low selectivity (common bigrams map to many candidates). The overhead of iterating long lists outweighs the cost of iterating all candidates. Bit Signatures (Bloom filter style) provide a constant-time O(32) intersection check that is significantly faster than Set.has() loop O(Bigrams), and avoids the memory/iteration overhead of Inverted Indexes.
**Action:** For fuzzy matching sets of tokens (like bigrams) against a few thousand candidates, prefer Bit Signatures (popcount intersection) over Inverted Indexes or Set intersections. Ensure denominator uses popcount(A)+popcount(B) to maintain identity property (Similarity(A,A)=1.0).
