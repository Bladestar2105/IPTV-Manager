## 2026-03-20 - Missing ARIA Attributes in Bootstrap Tabs
**Learning:** Bootstrap's tab components (`.nav-tabs`, `.nav-item`, `.nav-link`, `.tab-pane`) do not automatically receive the necessary ARIA roles and attributes required for screen reader accessibility in this vanilla JS implementation.
**Action:** When implementing or updating Bootstrap tabbed interfaces (like `#user-tabs`), explicitly add `role="presentation"` to the `li.nav-item` wrappers, add `role="tab"`, `aria-controls`, and `aria-selected` to the tab `<button>` elements, and apply `role="tabpanel"` with `aria-labelledby` to the corresponding `.tab-pane` content containers.

## 2026-03-20 - Skip-to-Content Link Focus Routing
**Learning:** The "Skip to content" link at the top of the document correctly points to `#main-content`, but the target container lacked the ability to receive programmatic focus, causing the skip link to fail in some browsers or screen reader configurations.
**Action:** Always add `tabindex="-1"` to the target container of a skip link (e.g., `<div id="main-content" tabindex="-1">`) to ensure reliable focus management and proper accessibility.
