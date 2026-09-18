import http from 'http';
import https from 'https';
import fetch from 'node-fetch';
import { isSafeUrl, safeLookup, sanitizeErrorMessage } from './helpers.js';
import { resolveBudget } from './env.js';

// Custom Agents with DNS Rebinding Protection
const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });
const httpsSelfSignedAgent = new https.Agent({
  lookup: safeLookup,
  rejectUnauthorized: false,
});

/**
 * Strip credentials from an error that is about to leave this function.
 *
 * node-fetch builds its message as `request to ${url} failed, reason: …`, and a
 * provider URL carries the panel password in its query string. Every caller that
 * logs a failed fetch therefore printed that password to stdout. The name and
 * the system error code are preserved because callers branch on `AbortError`
 * and on codes like ECONNREFUSED; the original object is returned untouched
 * when it held nothing to redact, so the common abort keeps its stack.
 */
function withoutCredentials(error) {
  const message = sanitizeErrorMessage(error);
  if (!error || message === error.message) return error;
  const safe = new Error(message);
  safe.name = error.name || 'Error';
  for (const key of ['code', 'type', 'errno']) {
    if (error[key] !== undefined) safe[key] = error[key];
  }
  return safe;
}

const DEFAULT_HEADER_TIMEOUT_MS = 15000;
const DEFAULT_MAX_DURATION_MS = 600000;
const MIN_MAX_DURATION_MS = 1000;

/**
 * Hard upper bound for the wait for response headers across a whole redirect
 * chain. Explicitly NOT the body: see fetchSafe below for why bounding that by
 * default cut live streams at the deadline.
 *
 * This gates every outgoing request in the application, so it has a floor: a
 * value of `10` — which is what `10m` parses to — would abort every fetch after
 * ten milliseconds, and the resulting AbortError is indistinguishable from a
 * genuine upstream timeout.
 */
export function resolveMaxRequestDurationMs(raw = process.env.HTTP_MAX_REQUEST_MS) {
  return resolveBudget(raw, DEFAULT_MAX_DURATION_MS, MIN_MAX_DURATION_MS, Number.MAX_SAFE_INTEGER, 'HTTP_MAX_REQUEST_MS');
}

/**
 * SSRF-safe fetch with two separate time budgets.
 *
 * `timeout` bounds the wait for the response *headers*, including redirects.
 * The body is deliberately NOT bounded here: most bodies this function returns
 * are media streamed to a player, and a healthy live session outlives any fixed
 * duration. Bounding them by default meant one missed call site cut a viewer's
 * stream at the deadline.
 *
 * A caller that buffers a finite document bounds the read itself with
 * `readBodyWithLimit()`, which owns both the time and the size cap. Forgetting
 * that leaves the body unbounded — the behaviour before this budget existed —
 * instead of terminating a stream.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout=15000] time to response headers, per hop
 * @param {number} [options.maxDurationMs] headers + redirects; default HTTP_MAX_REQUEST_MS
 * @param {number} [options.maxBytes] reject when Content-Length exceeds this
 * @param {boolean} [options.allowSelfSigned=false]
 */
export async function fetchSafe(url, options = {}, redirectCount = 0, deadline = null) {
  if (redirectCount > 5) {
    throw new Error('Too many redirects');
  }

  // Ensure URL is valid and safe (pre-check)
  if (!(await isSafeUrl(url))) {
    // The rejected URL is worth naming, its query string is not.
    throw new Error(sanitizeErrorMessage(`Unsafe URL: ${url}`));
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
  // One timer, covering the wait for the headers of this hop, bounded by what is
  // left of the overall budget for the redirect chain.
  const headerTimer = setTimeout(abort, Math.min(headerTimeout, remainingTotal()));
  headerTimer.unref?.();
  const disarm = () => clearTimeout(headerTimer);

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
    throw withoutCredentials(e);
  }

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
    throw withoutCredentials(e);
  }

  disarm();
  return response;
}

const DEFAULT_BODY_TIMEOUT_MS = 120000;

/**
 * Read a finite response body with a time and a size cap.
 *
 * For the callers that buffer a whole document — provider catalogs, series info,
 * EPG metadata, manifests, proxied images. `fetchSafe` bounds only the headers,
 * so without this a server that answers fast and then stalls its body hangs the
 * caller for as long as the socket stays open.
 *
 * @param {Response} response a node-fetch response from fetchSafe
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000] budget for reading the whole body
 * @param {number} [options.maxBytes] reject once this many bytes arrived
 * @param {'text'|'json'|'buffer'} [options.as='text']
 */
// The calls this function replaced (`response.text()`, `response.json()`) decode
// through TextDecoder, which drops a leading UTF-8 BOM. `Buffer#toString('utf8')`
// keeps it, and a kept BOM is not cosmetic: JSON.parse rejects the document
// outright, and in an m3u8 it displaces the `#` that the manifest rewriter's
// `^(?!#)` anchor tests for, so the `#EXTM3U` line gets rewritten as a URL.
// Xtream panels are typically PHP, where a stray BOM in an included file is a
// classic accident, so decode exactly as the replaced calls did.
const utf8Decoder = new TextDecoder('utf-8');
const decodeUtf8 = buffer => utf8Decoder.decode(buffer);

export async function readBodyWithLimit(response, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_BODY_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 0;
  const as = options.as || 'text';
  const body = response.body;

  if (!body || typeof body.on !== 'function') {
    // No Node stream to meter — an already-buffered body or a test double.
    // Fall back to the response's own reader; there is nothing to bound.
    if (as === 'json' && typeof response.json === 'function') return response.json();
    if (as === 'buffer' && typeof response.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer());
    }
    const text = typeof response.text === 'function' ? await response.text() : '';
    return as === 'json' ? JSON.parse(text) : as === 'buffer' ? Buffer.from(text) : text;
  }

  const chunks = [];
  let received = 0;

  const buffer = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) { resolve(value); return; }
      body.destroy?.();
      reject(error);
    };
    const abort = message => {
      const error = new Error(message);
      error.name = 'AbortError';
      return error;
    };
    // Deliberately NOT unref'd. For a socket-backed body the socket already
    // holds the loop open, so this costs nothing there; for any other stream it
    // is the difference between the documented timeout and a promise that never
    // settles while the process quietly exits.
    const timer = setTimeout(() => finish(abort('The operation was aborted.')), timeoutMs);

    body.on('data', chunk => {
      // A stream may hand out strings rather than Buffers; normalize so the
      // byte count and the concatenation below are both correct.
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += piece.length;
      if (maxBytes && received > maxBytes) {
        finish(new Error(`Response too large: exceeded the ${maxBytes} byte limit`));
        return;
      }
      chunks.push(piece);
    });
    body.once('error', error => finish(error));
    body.once('end', () => finish(null, Buffer.concat(chunks)));
    // A socket destroyed without an error — a shutdown, an upstream that goes
    // away — emits neither 'end' nor 'error'. Without this the read waits out
    // its whole deadline for a body that can no longer arrive.
    body.once('close', () => finish(abort('The response body closed before it was complete.')));
  });

  if (as === 'buffer') return buffer;
  const text = decodeUtf8(buffer);
  return as === 'json' ? JSON.parse(text) : text;
}

/**
 * Destroy a stream that has not finished within `timeoutMs`.
 *
 * For consumers that pipe a body into a parser instead of buffering it, where
 * `readBodyWithLimit` does not apply. `fetchSafe` bounds only the wait for the
 * headers, so without this such a read has no upper bound at all.
 *
 * @returns {Function} call it once the read finished, to disarm the deadline
 */
export function armStreamDeadline(stream, timeoutMs, message = 'Stream exceeded its deadline') {
  if (!stream || typeof stream.destroy !== 'function' || !(Number(timeoutMs) > 0)) return () => {};
  const timer = setTimeout(() => {
    const error = new Error(message);
    error.name = 'AbortError';
    try { stream.destroy(error); } catch { /* already gone */ }
  }, Number(timeoutMs));
  timer.unref?.();
  return () => clearTimeout(timer);
}
