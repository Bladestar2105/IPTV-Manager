## 2026-03-20 - Added ARIA Labels to Missing Form Elements
**Learning:** In this application, inputs and selects sometimes lack explicit `<label>` tags (especially within modals or tight UI spaces like tables/cards). While `data-i18n-placeholder` provides visual guidance, it does not suffice for screen readers. Furthermore, decorative or icon-only buttons (like the toggle password visibility button) often lack `aria-hidden="true"` on their child `<i>` elements, even if the parent button has an `aria-label`.
**Action:** When adding or auditing inputs/selects without explicit labels, always ensure an `aria-label` is present (and localized via `data-i18n-label`). Additionally, when using icon fonts (like `bi-eye`) inside buttons that already have `aria-label`, explicitly add `aria-hidden="true"` to the `<i>` tag to prevent redundant or confusing screen reader announcements.

## 2025-01-20 - Add character count for limited inputs
**Learning:** When inputs have a strict `maxlength` (like the user notes field), relying solely on a placeholder or HTML validation is poor UX, as users don't know how close they are to the limit. Adding a visual character count provides immediate feedback.
**Action:** Always pair `maxlength` attributes with a dynamic character count indicator in the UI.

## 2026-04-03 - Do not override native labels with aria-label
**Learning:** While trying to ensure screen readers announce input fields correctly, adding `aria-label` (and `data-i18n-label`) to an input that already has a properly associated `<label for="...">` overrides the native `<label>`. This causes a serious accessibility regression because screen readers will announce the `aria-label` (e.g., "123456" for an OTP input) instead of the actual contextual label (e.g., "2FA Code").
**Action:** Before adding `aria-label` to an input field, verify whether it already has an associated `<label>`. Only use `aria-label` as a fallback when a visible `<label>` cannot be used.
