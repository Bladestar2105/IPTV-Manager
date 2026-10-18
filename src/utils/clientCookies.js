import { CookieJar } from 'tough-cookie';

const entries = headers => headers?.entries ? [...headers.entries()] : Object.entries(headers || {});
const restoreJar = value => value ? CookieJar.deserializeSync(value) : new CookieJar();
const crossOriginHeaders = new Set([
  'user-agent', 'accept', 'accept-language', 'accept-encoding',
  'range', 'if-range', 'if-match', 'if-modified-since', 'if-none-match', 'content-type', 'content-length',
]);

// Grants carry the jar encrypted; Cookie headers are selected only at request time.
export function createUpstreamContext(headers, sourceUrl, cookieJar = null, headerOrigin = sourceUrl, seedCookies = !cookieJar) {
  const jar = restoreJar(cookieJar);
  const next = {};
  for (const [name, value] of entries(headers)) {
    if (name.toLowerCase() !== 'cookie') { next[name] = value; continue; }
    if (!seedCookies) continue;
    const source = new URL(sourceUrl);
    for (const pair of String(value).split(';')) {
      jar.setCookieSync(`${pair.trim()}; Path=/${source.protocol === 'https:' ? '; Secure' : ''}`, source.href, { ignoreError: true });
    }
  }
  return { headers: next, cookieJar: jar.serializeSync(), headerOrigin };
}

export function upstreamRequestHeaders(context, targetUrl) {
  const sameOrigin = new URL(context.headerOrigin || targetUrl).origin === new URL(targetUrl).origin;
  const headers = Object.fromEntries(entries(context.headers).filter(([name]) =>
    name.toLowerCase() !== 'cookie' && (sameOrigin || crossOriginHeaders.has(name.toLowerCase()))));
  const cookie = restoreJar(context.cookieJar).getCookieStringSync(targetUrl);
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export function withUpstreamCookies(headers, response, sourceUrl, cookieJar = null, headerOrigin = sourceUrl) {
  const context = createUpstreamContext(headers, sourceUrl, response.upstreamCookieJar || cookieJar, headerOrigin);
  if (response.upstreamCookieJar) return context;
  const jar = restoreJar(context.cookieJar);
  const setCookies = response.headers?.raw?.()['set-cookie'] || response.headers?.getSetCookie?.() || [response.headers?.get?.('set-cookie')];
  for (const value of setCookies) if (value) jar.setCookieSync(value, response.url || sourceUrl, { ignoreError: true });
  return { ...context, cookieJar: jar.serializeSync() };
}
