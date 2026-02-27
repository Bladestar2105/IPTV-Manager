## 2025-05-15 - [Localized ARIA Labels]
**Learning:** The app's i18n system (`translatePage`) only handled text content and placeholders. Static icon-only buttons lacked accessible names.
**Action:** Extended `translatePage` to handle `data-i18n-label`, allowing declarative, localized `aria-label` assignment in HTML. For dynamic elements, use `setAttribute('aria-label', t('key'))`.

## 2025-05-15 - [Localized Tooltips]
**Learning:** Icon-only buttons provided no context on hover, relying solely on icons or screen reader labels.
**Action:** Extended `translatePage` to handle `data-i18n-title`, allowing declarative localized `title` attributes. Updated dynamic buttons to explicitly set `.title` property for consistent tooltip experience.

## 2024-10-24 - [Async UI State Restoration]
**Learning:** When adding loading states to elements that trigger content updates (like "Load More" buttons), the element itself might be replaced or moved by the resulting render function.
**Action:** Always re-query the DOM element by ID after the await completes before attempting to restore its state (text, disabled status), rather than relying on the closure variable reference.

## 2025-05-20 - [Password Visibility Toggle]
**Learning:** Admin dashboards often display sensitive data like passwords in plain text for convenience, which compromises privacy (shoulder surfing).
**Action:** Default password fields to `type="password"` even for read-only displays, and add a "Show/Hide" toggle button. This balances security (default hidden) with utility (revealable).

## 2025-05-22 - [Clearable Search Input Pattern]
**Learning:** Standard search inputs require users to manually delete text to reset filters, which is tedious on mobile or with long queries.
**Action:** Implemented a reusable pattern wrapping inputs in a Bootstrap `input-group` with a hidden "X" button. A single `initClearableInput` helper handles the toggle logic and dispatches `input` events so existing live-search listeners update automatically.

## 2025-05-23 - [Accessible Form Help Text]
**Learning:** Helper text placed adjacent to inputs (like instructions for date formats or password requirements) is often visually associated but programmatically disconnected for screen reader users.
**Action:** Assign unique IDs to helper text elements (e.g., `id="password-help"`) and explicitly link them to their inputs using `aria-describedby="password-help"`. Ensure labels also have `for` attributes matching input `id`s.

## 2026-02-21 - [Accessible Copy Feedback]
**Learning:** The existing `copyToClipboard` utility updated the visual button state (icon/text) but failed to update the accessible name (`aria-label`) or tooltip (`title`), leaving screen reader users unaware of the success state.
**Action:** Updated the shared `copyToClipboard` function to dynamically set `aria-label` and `title` to "Copied!" during the success timeout, and added a toast notification for redundant, assertive feedback.

## 2026-02-24 - [Async Loading States]
**Learning:** Users lack feedback during critical create/update operations (User, Provider, Category), leading to uncertainty or double submissions. While `setLoadingState` existed, it was inconsistent across the app's main forms.
**Action:** Systematically applied `setLoadingState(btn, true/false)` to all form submission handlers (`user-form`, `provider-form`, `category-form`, `edit-user-form`), ensuring the state is reset in a `finally` block to prevent UI deadlocks on error.

## 2026-03-01 - [Non-Blocking Notifications]
**Learning:** Standard browser `alert()` dialogs block the entire UI thread, disrupting user flow for routine success confirmations (e.g., "Settings saved").
**Action:** Replaced `alert()` calls with `showToast(msg, 'success/danger')` for administrative actions like Sync and EPG updates. This provides visible feedback without interrupting the workflow.
