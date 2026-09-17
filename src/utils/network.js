import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { isSafeUrl, safeLookup } from './helpers.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });
const httpsSelfSignedAgent = new https.Agent({
  lookup: safeLookup,
  rejectUnauthorized: false,
});

const DEFAULT_HEADER_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DURATION_MS = 600000;

/** Hard upper bound for one exchange including redirects and the response body. */
export function resolveMaxRequestDurationMs(raw = process.env.HTTP_MAX_REQUEST_MS) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DURATION_MS;
  return parsed;
}

/**
 * SSRF-safe fetch with two separate time budgets.
 *
 * `timeout` bounds the wait for the response *headers*, as before. It used to be
 * the only timer, and it was cleared as soon as the headers arrived — which left
 * the body download completely unbounded, so a provider that answers fast and
 * then stalls could hang a sync indefinitely. `maxDurationMs` now bounds the
 * whole exchange, including redirects and reading the body.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout=15000] time to response headers, per hop
 * @param {number} [options.maxDurationMs] whole exchange; default HTTP_MAX_REQUEST_MS
 * @param {number} [options.maxBytes] reject when Content-Length exceeds this
 * @param {boolean} [options.allowSelfSigned=false]
 */
export async function fetchSafe(url, options = {}, redirectCount = 0, deadline = null) {
  if (redirectCount > 5) {
    throw new Error('Too many redirects');
  }

  // Ensure URL is valid and safe (pre-check)
  if (!(await isSafeUrl(url))) {
    throw new Error(`Unsafe URL: ${url}`);
  }

  const {
    timeout: requestTimeout = DEFAULT_HEADER_TIMEOUT_MS,
    maxDurationMs,
    maxBytes,
    allowSelfSigned = false,
    ...fetchOptionOverrides
  } = options;

  const headerTimeout = requestTimeout || DEFAULT_HEADER_TIMEOUT_MS;
  const totalBudget = Number(maxDurationMs) > 0 ? Number(maxDurationMs) : resolveMaxRequestDurationMs();
  // The total budget is a hard cap. Raising it to the header timeout when the
  // caller asked for a smaller one would silently ignore the configured limit;
  // the header timer is capped by the remaining total instead.
  const effectiveDeadline = deadline ?? Date.now() + totalBudget;
  const remainingTotal = () => effectiveDeadline - Date.now();

  if (remainingTotal() <= 0) {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }

  const controller = new AbortController();
  const signal = fetchOptionOverrides.signal
    ? AbortSignal.any([fetchOptionOverrides.signal, controller.signal])
    : controller.signal;

  const abort = () => controller.abort();
  const headerTimer = setTimeout(abort, Math.min(headerTimeout, remainingTotal()));
  const totalTimer = setTimeout(abort, remainingTotal());
  // A caller that never reads the body would otherwise keep these timers, and
  // with them the event loop, alive until the deadline.
  headerTimer.unref?.();
  totalTimer.unref?.();
  let armed = true;
  const disarm = () => {
    if (!armed) return;
    armed = false;
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
  };

  const fetchOptions = {
    ...fetchOptionOverrides,
    signal,
    redirect: 'manual', // Handle redirects manually to re-verify new URL
    agent: (_parsedUrl) => {
      if (_parsedUrl.protocol !== 'https:') return httpAgent;
      return allowSelfSigned ? httpsSelfSignedAgent : httpsAgent;
    },
  };

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (e) {
    disarm();
    throw e;
  }

  // Headers are in; only the total budget still applies from here on.
  clearTimeout(headerTimer);

  try {
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const location = response.headers.get('location');
      let nextUrl;
      try {
        nextUrl = new URL(location, url).toString(); // Handle relative URLs
      } finally {
        response.body?.destroy?.();
      }
      disarm();
      return await fetchSafe(nextUrl, options, redirectCount + 1, effectiveDeadline);
    }

    if (Number(maxBytes) > 0) {
      // Header-based guard: it only helps when the server announces a length,
      // but it rejects an oversized payload before a byte of it is read.
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > Number(maxBytes)) {
        response.body?.destroy?.();
        disarm();
        throw new Error(`Response too large: ${declared} bytes exceeds the ${maxBytes} byte limit`);
      }
    }
  } catch (e) {
    disarm();
    throw e;
  }

  const body = response.body;
  if (body && typeof body.once === 'function') {
    // Keep the abort armed while the body streams. The listeners also make sure
    // a late abort never surfaces as an unhandled 'error' on an unread body.
    body.once('end', disarm);
    body.once('close', disarm);
    body.once('error', disarm);
  } else {
    disarm();
  }

  return response;
}
