## 2025-02-14 - Async loading state for dynamic icon-only buttons
**Learning:** Async delete actions attached to dynamically generated list items lacked visual feedback during processing, which can lead to duplicate clicks or confusion on slow networks. The existing `setLoadingState` utility perfectly supports icon-only buttons and prevents losing the original icon when called with `showText = false`.
**Action:** Always wrap async operations on list items with `setLoadingState(btn, true, '', false)` and ensure a `try/catch` block gracefully restores the button state (`setLoadingState(btn, false)`) on failure.

## 2025-02-14 - Empty States and Focus Visible
**Learning:** Found existing proper empty states across the application and confirmed focus indicators are inherited from bootstrap.
**Action:** Continued to rely on bootstrap native styles for focus rings and existing empty state components.
