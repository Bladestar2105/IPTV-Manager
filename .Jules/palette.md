## 2025-05-15 - [Localized ARIA Labels]
**Learning:** The app's i18n system (`translatePage`) only handled text content and placeholders. Static icon-only buttons lacked accessible names.
**Action:** Extended `translatePage` to handle `data-i18n-label`, allowing declarative, localized `aria-label` assignment in HTML. For dynamic elements, use `setAttribute('aria-label', t('key'))`.

## 2025-05-15 - [Localized Tooltips]
**Learning:** Icon-only buttons provided no context on hover, relying solely on icons or screen reader labels.
**Action:** Extended `translatePage` to handle `data-i18n-title`, allowing declarative localized `title` attributes. Updated dynamic buttons to explicitly set `.title` property for consistent tooltip experience.

## 2025-05-15 - [Keyboard Accessible List Items]
**Learning:** List items (`span` elements) used for selecting users and categories were only clickable (`onclick`) and lacked keyboard support, making the app unusable for keyboard-only users.
**Action:** Created `makeAccessible` helper to add `tabindex="0"`, `role="button"`, and `onkeydown` handler (Enter/Space support) to interactive non-button elements.
