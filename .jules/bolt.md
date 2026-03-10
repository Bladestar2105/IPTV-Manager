## 2026-03-09 - SQLite Grouping & Ordering Optimization
**Learning:** Using `ORDER BY X ASC, Y ASC` explicitly can eliminate multiple temporary B-trees in SQLite if a composite index exists on `(X, Y)`, completely skipping both sorting AND grouping passes when combined with grouping/aggregate functions like `json_group_array`.
**Action:** Always verify `EXPLAIN QUERY PLAN` when utilizing `GROUP BY` and ensure the inner `ORDER BY` mirrors existing composite indices.

## 2026-03-09 - Memory Update Regression
**Learning:** Overwriting memory files completely deletes previous learning entries which acts as the agent's memory.
**Action:** Always append (`>>`) or use specific tools to edit memory files rather than overwriting (`>`) to ensure past learnings are preserved.
