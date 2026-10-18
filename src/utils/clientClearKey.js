// Undefined means this is a URL candidate, not inline ClearKey material.
export function normalizeInlineClearKey(value) {
  const inline = value.trim();
  if (/^[a-f\d]{32}:[a-f\d]{32}$/i.test(inline)) return inline;
  if (!inline.startsWith('{')) return undefined;
  try {
    const jwks = JSON.parse(inline);
    const validKey = key => key && typeof key === 'object' &&
      Object.keys(key).every(field => ['kty', 'kid', 'k'].includes(field)) &&
      key.kty === 'oct' && [key.kid, key.k].every(item => typeof item === 'string' && /^[A-Za-z0-9_-]{22}(?:==)?$/.test(item));
    if (jwks && Object.keys(jwks).every(field => ['keys', 'type'].includes(field)) &&
        Array.isArray(jwks.keys) && jwks.keys.length && jwks.keys.every(validKey) &&
        (jwks.type === undefined || ['temporary', 'persistent-license'].includes(jwks.type))) return inline;
  } catch { /* Malformed key material must not become a provider-relative URL. */ }
  return '';
}
