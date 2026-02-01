## 2025-05-15 - [Localized ARIA Labels]
**Learning:** The app's i18n system (`translatePage`) only handled text content and placeholders. Static icon-only buttons lacked accessible names.
**Action:** Extended `translatePage` to handle `data-i18n-label`, allowing declarative, localized `aria-label` assignment in HTML. For dynamic elements, use `setAttribute('aria-label', t('key'))`.
