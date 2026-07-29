export function normalizeMac(value) {
  if (value === null || value === undefined) return null;

  let decoded = Array.isArray(value) ? value[0] : String(value);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }

  const compact = decoded.trim().replace(/[:-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(compact)) return null;
  return compact.toUpperCase().match(/.{2}/g).join(':');
}
