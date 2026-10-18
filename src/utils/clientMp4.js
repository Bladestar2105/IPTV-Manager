import { Transform } from 'node:stream';
import { rewritePlayReadyPsshBuffer } from './clientPlayReady.js';

const MAX_METADATA = 32 * 1024 * 1024;
const MAX_LICENSE_URLS = 256;
const referenceTypes = new Set(['rmra', 'rmda', 'rdrf', 'cmov']);
const metadataTypes = new Set(['moov', 'moof', 'pssh', 'meta', 'dref', 'stsd', 'hdlr', ...referenceTypes]);
const containerTypes = new Set(['moov', 'moof', 'trak', 'mdia', 'minf', 'dinf', 'traf', 'meta', 'udta', 'stbl', 'sinf']);
const unsafeSampleTypes = new Set(['stpp', 'rtsp', 'sdp ', 'moov', 'enct', 'encs']);
const initialTypes = new Set(['ftyp', 'styp', ...metadataTypes, 'mdat', 'sidx', 'ssix', 'free', 'skip', 'wide', 'pdin', 'uuid', 'emsg', 'prft']);
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

function validateDataReferences(body, header) {
  let offset = header.headerSize;
  if (body.length - offset < 8 || body.readUInt32BE(offset) !== 0) invalid('invalid data reference FullBox');
  const count = body.readUInt32BE(offset + 4); offset += 8;
  if (count > Math.floor((body.length - offset) / 12)) invalid('invalid data reference count');
  for (let index = 0; index < count; index++) {
    const entry = readHeader(body, offset);
    if (!entry) invalid('truncated data reference');
    const size = entry.size || body.length - offset;
    // Only the self-contained URL entry has no external location to follow.
    if (size > body.length - offset || entry.type !== 'url ' || size !== entry.headerSize + 4 || body.readUInt32BE(offset + entry.headerSize) !== 1) invalid('external or unsupported data reference');
    offset += size;
  }
  if (offset !== body.length) invalid('data reference count does not match entries');
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
  const visit = (value, info, start, depth) => {
    if (depth > 32) invalid('container nesting exceeds limit');
    if (referenceTypes.has(info.type)) invalid('external QuickTime reference movie');
    if (info.type === 'dref') { validateDataReferences(value, info); return; }
    let offset = info.headerSize;
    if (info.type === 'hdlr') {
      if (value.length - offset < 12) invalid('truncated handler metadata');
      if (value.toString('latin1', offset + 8, offset + 12) === 'strm') invalid('external streaming media handler');
      return;
    }
    if (info.type === 'stsd') {
      if (value.length - offset < 8 || value.readUInt32BE(offset) !== 0) invalid('invalid sample description FullBox');
      const count = value.readUInt32BE(offset + 4); offset += 8;
      if (count > Math.floor((value.length - offset) / 16)) invalid('invalid sample description count');
      for (let index = 0; index < count; index++) {
        const entry = readHeader(value, offset);
        if (!entry) invalid('truncated sample description');
        const size = entry.size || value.length - offset;
        if (size > value.length - offset || size < entry.headerSize + 8) invalid('invalid sample description size');
        if (unsafeSampleTypes.has(entry.type)) invalid('external or unsupported sample format');
        if (entry.type === 'encv' || entry.type === 'enca') {
          let prefix = entry.type === 'encv' ? 78 : 28;
          if (size < entry.headerSize + prefix) invalid('truncated encrypted sample entry');
          if (entry.type === 'enca') {
            const version = value.readUInt16BE(offset + entry.headerSize + 8);
            if (version > 2) invalid('unsupported encrypted audio entry');
            prefix += version === 1 ? 16 : version === 2 ? 36 : 0;
          }
          if (size < entry.headerSize + prefix) invalid('truncated encrypted sample entry');
          const entryBody = value.subarray(offset, offset + size);
          visit(entryBody, { ...entry, headerSize: entry.headerSize + prefix }, start + offset, depth + 1);
        }
        offset += size;
      }
      if (offset !== value.length) invalid('sample description count does not match entries');
      return;
    }
    if (info.type === 'meta') {
      if (value.length - offset < 4 || value.readUInt32BE(offset) !== 0) invalid('unsupported meta FullBox');
      offset += 4;
    }
    // Traverse only defined container layouts; sample and unknown leaf payloads
    // remain opaque. Data references are inspected through trak/mdia/minf/dinf.
    while (offset < value.length) {
      const child = readHeader(value, offset);
      if (!child) invalid('truncated child header');
      const size = child.size || value.length - offset;
      if (size > value.length - offset) invalid('child exceeds container');
      const payload = value.subarray(offset, offset + size);
      if (child.type === 'frma') {
        if (size !== child.headerSize + 4) invalid('invalid original sample format');
        if (unsafeSampleTypes.has(payload.toString('latin1', child.headerSize))) invalid('external encrypted sample format');
      } else if (child.type === 'pssh') {
        if (info.type !== 'moov' && info.type !== 'moof') invalid('unsupported PSSH location');
        rewritePlayReadyPsshBuffer(payload, boundedMapUrl, child.headerSize).copy(result, start + offset);
      } else if (child.type === 'moov' || child.type === 'moof') {
        invalid('nested movie containers');
      } else if (containerTypes.has(child.type) || child.type === 'dref' || child.type === 'stsd' || child.type === 'hdlr' || referenceTypes.has(child.type)) {
        visit(payload, child, start + offset, depth + 1);
      }
      offset += size;
    }
  };
  visit(body, header, 0, 0);
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
