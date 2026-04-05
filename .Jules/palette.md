## 2024-04-04 - [Accessibility] Hide decorative text icons in buttons
**Learning:** Screen readers announce text characters used as icons (like `◀`, `▶`, `✕`) literally (e.g. "Left pointing double angle quotation mark" or "Multiply"), confusing the user if the button already has an `aria-label`.
**Action:** Always wrap text-based icons in `<span aria-hidden="true">` to hide them from the accessibility tree, leaving only the descriptive `aria-label` or `data-i18n-label`.
