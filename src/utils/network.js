import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { isSafeUrl, safeLookup } from './helpers.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

export async function fetchSafe(url, options = {}, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error('Too many redirects');
  }

  // Ensure URL is valid and safe (pre-check)
  if (!(await isSafeUrl(url))) {
    throw new Error(`Unsafe URL: ${url}`);
  }

  const fetchOptions = {
    ...options,
    redirect: 'manual', // Handle redirects manually to re-verify new URL
    agent: (_parsedUrl) => (_parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent),
  };

  const response = await fetch(url, fetchOptions);

  if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
    const location = response.headers.get('location');
    const nextUrl = new URL(location, url).toString(); // Handle relative URLs
    return fetchSafe(nextUrl, options, redirectCount + 1);
  }

  return response;
}
