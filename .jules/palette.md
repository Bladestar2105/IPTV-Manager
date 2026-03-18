## 2026-03-12 - Consistent Password Toggle Accessibility
**Learning:** The password visibility toggle pattern in this app is generally good, using `data-toggle-password` and automatically updating the aria-label in JS (e.g. `public/app.js` line 416). However, some inputs (like the GeoIP License Key) use a different/inconsistent i18n label key (`togglePasswordVisibility` instead of `show_password`), and also have hardcoded `aria-label` attributes that bypass the dynamic translation, and use a different icon (`<i class="bi bi-eye"></i>` instead of `👁️`). This causes inconsistency for screen readers and visual users.
**Action:** Standardized all password toggle buttons to use `data-i18n-label="show_password"`, `data-i18n-title="show_password"`, and the `👁️` icon, ensuring the global toggle script in `app.js` correctly manages their state and translations.
## 2026-03-12 - Toast Close Button Missing Tooltip
**Learning:** The toast notification close buttons only had a `data-i18n-label`, but were missing a `data-i18n-title` like all other `.btn-close` buttons in the UI. Sighted mouse users didn't get a tooltip on hover for the toast close button.
**Action:** Add `data-i18n-title="close"` to the toast close button HTML template to ensure parity with modal close buttons.
## 2026-03-12 - Emojis vs Icon Fonts in Form Fields
**Learning:** When standardizing form inputs, do not blindly replace existing icon font classes (like `.bi-eye`) with emojis (like `👁️`) just to match other hardcoded parts of the app. Emojis break visual consistency, don't inherit text colors (crucial for dark mode), and removing hardcoded `aria-label`s before JS hydration is an accessibility regression.
**Action:** Avoid replacing proper icon fonts with emojis. Ensure icon-only buttons always have a fallback `aria-label` attribute in HTML.
## 2026-03-18 - Add ARIA attributes to mobile navbar toggler
**Learning:** The Bootstrap mobile navbar toggle button (`.navbar-toggler`) was missing standard ARIA attributes (`aria-controls` and `aria-expanded`), causing screen readers to not properly announce its state or purpose.
**Action:** When implementing or modifying Bootstrap collapse components, always explicitly initialize `aria-controls="<target_id>"` and `aria-expanded="false"` in the HTML markup. Bootstrap's JS will handle toggling the state, but the initial markup must be compliant.
