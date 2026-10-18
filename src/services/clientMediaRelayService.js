import { PassThrough, Readable, pipeline } from 'node:stream';
import { createMp4PrivacyTransform, rewriteMp4Metadata } from '../utils/clientMp4.js';
import { discardBody, fetchSafe, readBodyWithLimit } from '../utils/network.js';

const MAX_METADATA = 32 * 1024 * 1024;
function knownMp4(response, url) {
  const type=response.headers.get('content-type') || '';
  return /^(?:video|audio|application)\/mp4(?:;|$)/i.test(type) ||
    ((!type || /^application\/octet-stream(?:;|$)/i.test(type)) && /\.(?:mp4|m4s|m4a|m4v|cmfv|cmfa)(?:[?#]|$)/i.test(url || ''));
}
function knownMatroska(response, url) {
  const type = response.headers.get('content-type') || '';
  if (/^(?:video|audio|application)\/x-matroska(?:;|$)/i.test(type)) return true;
  if (type && !/^application\/octet-stream(?:;|$)/i.test(type)) return false;
  try { return /\.(?:mkv|mka)$/i.test(new URL(response.url || url).pathname); }
  catch { return false; }
}
const METADATA = new Set(['moov', 'moof', 'pssh', 'meta', 'dref', 'stsd', 'hdlr', 'rmra', 'rmda', 'rdrf', 'cmov']);
const unsafe = () => new Error('Unable to inspect upstream media range safely');
function contentRange(response) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!match) throw unsafe();
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) throw unsafe();
  return { start, end, total };
}
function result(response, body, headers = new Headers(response.headers), status = response.status) {
  return { status, statusText: response.statusText, ok: status >= 200 && status < 300,
    url: response.url, headers, body, upstreamCookieJar: response.upstreamCookieJar };
}
function privacyStream(response, mapUrl, signal, isMp4 = false) {
  // Wait for demand so callers can attach error handlers before parsing.
  let started = false;
  const output = new class extends PassThrough {
    _read(size) {
      if (!started) {
        started = true;
        const transform = createMp4PrivacyTransform((url, options) => mapUrl(url, options, response), { isMp4 });
        pipeline(response.body, transform, this, () => {});
      }
      super._read(size);
    }
  }();
  const abort = () => output.destroy(signal.reason instanceof Error ? signal.reason : new Error('Media request aborted'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  output.once('close', () => {
    signal?.removeEventListener('abort', abort);
    response.body.destroy();
  });
  return output;
}
function sliceStream(source, start, end, reachedRange) {
  const output = Readable.from((async function* () {
    let position = 0;
    try {
      for await (const chunk of source) {
        const stop = position + chunk.length;
        if (stop > start && position <= end) {
          reachedRange();
          yield chunk.subarray(Math.max(0, start-position), Math.min(chunk.length, end+1-position));
        }
        position = stop;
        if (position > end) return;
      }
      if (position <= end) throw unsafe();
    } finally { source.destroy(); }
  })());
  output.once('close', () => source.destroy());
  return output;
}
function overlayStream(source, range, replacements) {
  const output = Readable.from((async function* () {
    let position = range.start;
    try {
      for await (const input of source) {
        const chunk = Buffer.from(input);
        if (position + chunk.length > range.end + 1) throw unsafe();
        for (const replacement of replacements) {
          const start = Math.max(position, replacement.start);
          const end = Math.min(position + chunk.length, replacement.start + replacement.bytes.length);
          if (start < end) replacement.bytes.copy(chunk, start-position, start-replacement.start, end-replacement.start);
        }
        position += chunk.length; yield chunk;
      }
      if (position !== range.end + 1) throw unsafe();
    } finally { source.destroy(); }
  })());
  output.once('close', () => source.destroy());
  return output;
}

/** Inspect whole MP4 metadata even when the client asks for bytes inside a PSSH.
 * Additional reads use fetchSafe and the caller's upstream-only cookie/header context.
 */
export async function prepareClientMediaResponse(upstream, { url = upstream.url, fetchOptions = {}, mapUrl, inspectMp4 = true } = {}) {
  if (!inspectMp4 || !upstream.body || ![200, 206].includes(upstream.status)) return upstream;
  // Matroska is relayed unchanged; MP4 DRM inspection must not turn MKV seeks into full downloads.
  if (knownMatroska(upstream, url)) return upstream;
  if (upstream.status === 200) {
    const headers = new Headers(upstream.headers);
    if (/^(?:gzip|deflate|br)$/i.test(headers.get('content-encoding') || '')) {
      headers.delete('content-encoding'); headers.delete('content-length');
    }
    return result(upstream, privacyStream(upstream, mapUrl, fetchOptions.signal, knownMp4(upstream, url)), headers);
  }
  let range;
  try { range = contentRange(upstream); } catch (error) { discardBody(upstream); throw error; }
  discardBody(upstream);
  const etag = upstream.headers.get('etag');
  const strong = etag && /^"[^"\r\n]*"$/.test(etag);
  const controller = new AbortController();
  const signal = fetchOptions.signal ? AbortSignal.any([fetchOptions.signal, controller.signal]) : controller.signal;
  const deadline = Date.now() + 30_000;
  const timer = setTimeout(() => controller.abort(unsafe()), 30_000);
  timer.unref?.();
  let cookieJar = upstream.upstreamCookieJar || fetchOptions.cookieJar;
  let streamingFallback = false;
  const fetchMedia = async (start, end, pinned = false) => {
    const headers = new Headers(fetchOptions.headers);
    for (const key of ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since']) headers.delete(key);
    // Byte positions must describe the identity representation.
    headers.set('accept-encoding', 'identity');
    if (start !== undefined) headers.set('range', `bytes=${start}-${end}`);
    if (pinned) headers.set('if-match', etag);
    const response = await fetchSafe(url, { ...fetchOptions, headers: Object.fromEntries(headers), signal, cookieJar,
      timeout: Math.max(1, Math.min(fetchOptions.timeout || 15000, deadline-Date.now())), maxDurationMs: Math.max(1, deadline-Date.now()) });
    cookieJar = response.upstreamCookieJar || cookieJar;
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { discardBody(response); throw unsafe(); }
    return response;
  };
  const probe = async (start, end) => {
    const response = await fetchMedia(start, end, true);
    try {
      const actual = contentRange(response);
      if (response.status !== 206 || response.headers.get('etag') !== etag || actual.start !== start || actual.end !== end || actual.total !== range.total) throw unsafe();
      const bytes = await readBodyWithLimit(response, { as: 'buffer', maxBytes: end-start+1, timeoutMs: Math.max(1, deadline-Date.now()) });
      if (bytes.length !== end-start+1) throw unsafe();
      return bytes;
    } catch (error) { discardBody(response); throw error; }
  };
  try {
    if (strong) {
      try {
        const replacements = [];
        let position = 0, metadataBytes = 0, boxes = 0;
        while (position <= range.end) {
          if (++boxes > 4096 || range.total-position < 8) throw unsafe();
          let header = await probe(position, position+7);
          const type = header.toString('latin1',4,8);
          if (position === 0 && !/^[\x20-\x7e]{4}$/.test(type)) {
            if (knownMp4(upstream, url)) throw unsafe();
            break;
          }
          let size = header.readUInt32BE(0), headerSize = 8;
          if (size === 1) {
            if (range.total-position < 16) throw unsafe();
            header = await probe(position,position+15); headerSize = 16;
            const large = header.readBigUInt64BE(8); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafe();
            size = Number(large);
          }
          size ||= range.total-position;
          if (size < headerSize || size > range.total-position) {
            if (position === 0 && !knownMp4(upstream, url)) break;
            throw unsafe();
          }
          if (METADATA.has(type)) {
            metadataBytes += size; if (metadataBytes > MAX_METADATA) throw unsafe();
            replacements.push({ start: position, bytes: await probe(position, position+size-1) });
          }
          position += size;
        }
        const response = await fetchMedia(range.start, range.end, true);
        try {
          const actual = contentRange(response);
          if (response.status !== 206 || response.headers.get('etag') !== etag || actual.start !== range.start || actual.end !== range.end || actual.total !== range.total) throw unsafe();
          for (const replacement of replacements) replacement.bytes = rewriteMp4Metadata(replacement.bytes, (url, options) => mapUrl(url, options, response));
          return result(response, overlayStream(response.body, range, replacements));
        } catch (error) { discardBody(response); throw error; }
      } catch (error) {
        if (signal.aborted) throw error;
        // No trustworthy random access: inspect from byte zero instead.
      }
    }
    const full = await fetchMedia();
    if (full.status !== 200 || !/^\d+$/.test(full.headers.get('content-length') || '') || Number(full.headers.get('content-length')) !== range.total) {
      discardBody(full); throw unsafe();
    }
    const headers = new Headers(full.headers);
    headers.set('content-range', `bytes ${range.start}-${range.end}/${range.total}`);
    headers.set('content-length', String(range.end-range.start+1));
    const body = sliceStream(privacyStream(full, mapUrl, signal, knownMp4(full, url)), range.start, range.end, () => clearTimeout(timer));
    streamingFallback = true;
    body.once('close', () => clearTimeout(timer));
    return result(full, body, headers, 206);
  } finally { if (!streamingFallback) clearTimeout(timer); }
}
