// Set-Cookie attributes belong to the response, not the next request's Cookie header.
export function withUpstreamCookies(headers, response) {
  const next = { ...headers };
  const cookies = new Map();
  const remember = text => {
    const index = text.indexOf('=');
    if (index > 0) cookies.set(text.slice(0, index).trim(), text.slice(index + 1).trim());
  };
  for (const value of String(next.Cookie || next.cookie || '').split(';')) remember(value);
  const setCookies = response.headers.raw?.()['set-cookie'] || response.headers.getSetCookie?.() || [response.headers.get('set-cookie')];
  for (const value of setCookies) if (value) remember(value.split(';')[0]);
  delete next.cookie;
  delete next.Cookie;
  if (cookies.size) next.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  return next;
}
