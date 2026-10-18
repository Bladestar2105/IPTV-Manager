import { Transform } from 'node:stream';
import { rewritePlayReadyPsshBuffer } from './clientPlayReady.js';

const MAX_METADATA = 32 * 1024 * 1024;
const MAX_LICENSE_URLS = 256;
const metadataTypes = new Set(['moov', 'moof', 'pssh']);
const initialTypes = new Set(['ftyp', 'styp', 'moov', 'moof', 'pssh', 'mdat', 'sidx', 'ssix', 'free', 'skip', 'wide', 'pdin', 'uuid', 'emsg', 'prft']);
const invalid = message => { throw new Error(`Unsupported MP4 metadata: ${message}`); };
const validateLimit = limit => {
  if (!Number.isSafeInteger(limit) || limit < 16 || limit > MAX_METADATA) invalid('invalid buffer limit');
};

function readHeader(buffer, offset = 0) {
  if (buffer.length - offset < 8) return null;
  const shortSize = buffer.readUInt32BE(offset);
  const headerSize = shortSize === 1 ? 16 : 8;
  if (buffer.length - offset < headerSize) return null;
  const largeSize = shortSize === 1 ? buffer.readBigUInt64BE(offset + 8) : BigInt(shortSize);
  if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) invalid('box size exceeds safe integer');
  const size = Number(largeSize);
  if (shortSize !== 0 && size < headerSize) invalid('box size smaller than header');
  return { size, headerSize, type: buffer.toString('latin1', offset + 4, offset + 8) };
}

function rewriteBox(body, header, mapUrl, maxMetadataBytes) {
  if (body.length > maxMetadataBytes) invalid('metadata exceeds buffer limit');
  let mappedUrls = 0;
  const boundedMapUrl = (...args) => {
    if (++mappedUrls > MAX_LICENSE_URLS) invalid('license URL count exceeds metadata budget');
    return mapUrl(...args);
  };
  if (header.type === 'pssh') return rewritePlayReadyPsshBuffer(body, boundedMapUrl, header.headerSize);
  const result = Buffer.from(body);
  // PSSH is defined directly in moov and moof. Other child payloads (including
  // sample tables and encrypted samples) are deliberately never scanned as text.
  let offset = header.headerSize;
  while (offset < body.length) {
    const child = readHeader(body, offset);
    if (!child) invalid('truncated child header');
    const size = child.size || body.length - offset;
    if (size > body.length - offset) invalid('child exceeds container');
    if (child.type === 'pssh') {
      rewritePlayReadyPsshBuffer(body.subarray(offset, offset + size), boundedMapUrl, child.headerSize).copy(result, offset);
    } else if (child.type === 'moov' || child.type === 'moof') {
      invalid('nested movie containers');
    }
    offset += size;
  }
  return result;
}

export function rewriteMp4Metadata(buffer, mapUrl, { maxMetadataBytes = MAX_METADATA } = {}) {
  validateLimit(maxMetadataBytes);
  const result = Buffer.from(buffer);
  let offset = 0;
  while (offset < buffer.length) {
    const header = readHeader(buffer, offset);
    if (!header) invalid('truncated box header');
    const size = header.size || buffer.length - offset;
    if (size > buffer.length - offset) invalid('truncated box');
    if (metadataTypes.has(header.type)) rewriteBox(buffer.subarray(offset, offset + size), header, mapUrl, maxMetadataBytes).copy(result, offset);
    offset += size;
  }
  return result;
}

export function createMp4PrivacyTransform(mapUrl, { maxMetadataBytes = MAX_METADATA, isMp4 = false } = {}) {
  validateLimit(maxMetadataBytes);
  let pending = Buffer.alloc(0);
  // An authoritative MP4 response must never fall back to raw passthrough.
  let mode = isMp4 ? 'header' : 'sniff';
  let current = null;
  let remaining = 0;
  let storage = null;
  let buffered = 0;
  const appendMetadata = part => {
    const length = buffered + part.length;
    if (length > maxMetadataBytes) invalid('metadata exceeds buffer limit');
    if (length > storage.length) {
      const grown = Buffer.allocUnsafe(Math.min(maxMetadataBytes, Math.max(length, storage.length * 2)));
      storage.copy(grown, 0, 0, buffered); storage = grown;
    }
    part.copy(storage, buffered); buffered = length;
  };
  const finishMetadata = transform => {
    const body = storage.subarray(0, buffered);
    transform.push(rewriteBox(body, current, mapUrl, maxMetadataBytes));
    storage = null; buffered = 0; current = null; mode = 'header';
  };
  const finishUnknown = transform => {
    transform.push(storage.subarray(0, buffered));
    storage = null; buffered = 0; current = null; mode = 'header';
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        let input = chunk;
        while (input.length) {
          if (mode === 'pass') { this.push(input); break; }
          if (mode === 'sniff' || mode === 'header') {
            const needed = pending.length >= 8 && pending.readUInt32BE(0) === 1 ? 16 : 8;
            const take = Math.min(needed - pending.length, input.length);
            pending = Buffer.concat([pending, input.subarray(0, take)]);
            input = input.subarray(take);
            if (pending.length < 8) continue;
            if (mode === 'sniff') {
              const type = pending.toString('latin1', 4, 8);
              const size = pending.readUInt32BE(0);
              // ISO-BMFF permits unknown boxes before movie fragments. Their
              // payload can pass unchanged, but later boxes still need inspection.
              const plausibleBox = /^[\x20-\x7e]{4}$/.test(type) && (size === 0 || size === 1 || size >= 8);
              if (!initialTypes.has(type) && !plausibleBox) {
                this.push(pending); pending = Buffer.alloc(0); mode = 'pass'; continue;
              }
              if (initialTypes.has(type)) mode = 'header';
            }
            try { current = readHeader(pending); } catch (error) {
              if (mode !== 'sniff') throw error;
              this.push(pending); pending = Buffer.alloc(0); mode = 'pass'; continue;
            }
            if (!current) continue;
            remaining = current.size ? current.size - current.headerSize : Infinity;
            if (mode === 'sniff') {
              // Unknown four-character types also occur in raw AES keys. Commit
              // to box parsing only once the entire first box has arrived.
              storage = Buffer.allocUnsafe(Math.min(current.size || 65536, 65536, maxMetadataBytes));
              appendMetadata(pending); mode = 'unknown';
            } else if (metadataTypes.has(current.type)) {
              if (current.size > maxMetadataBytes) invalid('metadata exceeds buffer limit');
              storage = Buffer.allocUnsafe(current.size || Math.min(65536, maxMetadataBytes));
              appendMetadata(pending); mode = 'metadata';
            } else { this.push(pending); mode = 'payload'; }
            pending = Buffer.alloc(0);
            if (!remaining) {
              if (mode === 'metadata') finishMetadata(this);
              else if (mode === 'unknown') finishUnknown(this);
              else mode = 'header';
            }
            continue;
          }
          const take = Math.min(remaining, input.length);
          const part = input.subarray(0, take);
          input = input.subarray(take); remaining -= take;
          if (mode === 'metadata' || mode === 'unknown') {
            appendMetadata(part);
          } else this.push(part);
          if (!remaining) {
            if (mode === 'metadata') finishMetadata(this);
            else if (mode === 'unknown') finishUnknown(this);
            else mode = 'header';
          }
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      try {
        if (mode === 'sniff') this.push(pending);
        else if (mode === 'unknown') finishUnknown(this);
        else if (mode === 'metadata' && remaining === Infinity) finishMetadata(this);
        else if ((mode === 'header' && pending.length) || (mode === 'metadata') || (mode === 'payload' && remaining !== Infinity)) invalid('truncated stream');
        callback();
      } catch (error) { callback(error); }
    }
  });
}
