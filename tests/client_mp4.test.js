import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { rewriteMp4Metadata, createMp4PrivacyTransform } from '../src/utils/clientMp4.js';

const system = Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex');
const origin = 'https://provider.example/licenses/very-long-private-token-secret';
const target = 'https://manager.test/r/abcdefghijklmnopqrstuv';
const key = '<KID CHECKSUM="keep" VALUE="same"/>';
function box(type, payload, extended = false) {
  const output = Buffer.alloc((extended ? 16 : 8) + payload.length);
  output.writeUInt32BE(extended ? 1 : output.length); output.write(type, 4);
  if (extended) output.writeBigUInt64BE(BigInt(output.length), 8);
  payload.copy(output, extended ? 16 : 8); return output;
}
function pssh({ version = 0, id = system, xml, extended = false } = {}) {
  const value = Buffer.from(xml || `<WRMHEADER><DATA>${key}<LA_URL>${origin}</LA_URL></DATA></WRMHEADER>`, 'utf16le');
  const pro = Buffer.alloc(value.length + 10);
  pro.writeUInt32LE(pro.length); pro.writeUInt16LE(1, 4); pro.writeUInt16LE(1, 6); pro.writeUInt16LE(value.length, 8); value.copy(pro, 10);
  const prefix = Buffer.alloc(version ? 44 : 24); prefix[0] = version; id.copy(prefix, 4);
  if (version) { prefix.writeUInt32BE(1, 20); prefix.fill(7, 24, 40); }
  prefix.writeUInt32BE(pro.length, prefix.length - 4);
  return box('pssh', Buffer.concat([prefix, pro]), extended);
}
function dataReference(type = 'url ', flags = 0, payload = Buffer.from('https://provider.example/private-samples?token=secret\0')) {
  const full = Buffer.alloc(4); full.writeUInt32BE(flags);
  const prefix = Buffer.alloc(8); prefix.writeUInt32BE(1, 4);
  let result = box('dref', Buffer.concat([prefix, box(type, Buffer.concat([full, payload]))]));
  for (const parent of ['dinf', 'minf', 'mdia', 'trak', 'moov']) result = box(parent, result);
  return result;
}
async function stream(input, options, split = 1) {
  const chunks = [];
  for (let offset = 0; offset < input.length; offset += split) chunks.push(input.subarray(offset, offset + split));
  const result = [];
  for await (const chunk of Readable.from(chunks).pipe(createMp4PrivacyTransform(() => target, options))) result.push(chunk);
  return Buffer.concat(result);
}
describe('length-preserving binary PlayReady privacy', () => {
  it.each(['url ', 'urn ', 'alis'])('rejects external %s data references in structured movie metadata', async type => {
    const value = dataReference(type);
    expect(() => rewriteMp4Metadata(value, () => target)).toThrow(/reference/i);
    await expect(stream(value)).rejects.toThrow(/reference/i);
  });
  it('preserves self-contained data references and rejects malformed counts and flags', async () => {
    const value = dataReference('url ', 1, Buffer.alloc(0));
    expect(rewriteMp4Metadata(value, () => target)).toEqual(value);
    expect(await stream(value)).toEqual(value);
    const badCount = Buffer.from(value); badCount.writeUInt32BE(2, 52);
    const badFlags = Buffer.from(value); badFlags[48] = 1;
    for (const bad of [badCount, badFlags, dataReference('url ', 1)]) {
      expect(() => rewriteMp4Metadata(bad, () => target)).toThrow();
    }
  });
  it.each(['rmra', 'rmda', 'rdrf', 'cmov'])('rejects QuickTime automatic reference movie box %s', async type => {
    for (const value of [box(type, Buffer.alloc(0)), box('moov', box(type, Buffer.alloc(0)))]) {
      expect(() => rewriteMp4Metadata(value, () => target)).toThrow(/reference/i);
      await expect(stream(value, { isMp4: true })).rejects.toThrow(/reference/i);
    }
  });
  it('inspects FullBox meta data references under user data and at top level', () => {
    const dref = dataReference().subarray(40);
    const meta = box('meta', Buffer.concat([Buffer.alloc(4), box('dinf', dref)]));
    for (const value of [meta, box('moov', box('trak', box('udta', meta)))]) {
      expect(() => rewriteMp4Metadata(value, () => target)).toThrow(/reference/);
    }
  });
  it.each(['stpp', 'rtsp', 'sdp ', 'moov', 'enct', 'encs'])('rejects sample format %s that can load external resources', async type => {
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(1, 4);
    const value = box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsd', Buffer.concat([prefix, box(type, Buffer.alloc(8))])))))));
    expect(() => rewriteMp4Metadata(value, () => target)).toThrow(/sample format/);
    await expect(stream(value)).rejects.toThrow(/sample format/);
  });
  it('rejects streaming handlers and encrypted unsafe original formats while preserving CENC video', () => {
    const handler = Buffer.alloc(24); handler.write('strm', 8);
    expect(() => rewriteMp4Metadata(box('moov', box('trak', box('mdia', box('hdlr', handler)))), () => target)).toThrow(/streaming/);
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(1, 4);
    const encrypted = original => box('moov', box('stbl', box('stsd', Buffer.concat([prefix, box('encv', Buffer.concat([Buffer.alloc(78), box('sinf', box('frma', Buffer.from(original)))]))]))));
    expect(() => rewriteMp4Metadata(encrypted('stpp'), () => target)).toThrow(/sample format/);
    const safe = encrypted('avc1'); expect(rewriteMp4Metadata(safe, () => target)).toEqual(safe);
    for (const version of [0, 1, 2]) {
      const payload = Buffer.alloc(version === 0 ? 28 : version === 1 ? 44 : 64); payload.writeUInt16BE(version, 8);
      const audio = box('moov', box('stbl', box('stsd', Buffer.concat([prefix, box('enca', Buffer.concat([payload, box('sinf', box('frma', Buffer.from('mp4a')))]))]))));
      expect(rewriteMp4Metadata(audio, () => target)).toEqual(audio);
    }
  });
  it('bounds nested metadata validation and validates every sample description entry', () => {
    let nested = box('dinf', Buffer.alloc(0));
    for (let index = 0; index < 33; index++) nested = box('udta', nested);
    expect(() => rewriteMp4Metadata(box('moov', nested), () => target)).toThrow(/nesting/);
    const prefix = Buffer.alloc(8); prefix.writeUInt32BE(2, 4);
    expect(() => rewriteMp4Metadata(box('stsd', Buffer.concat([prefix, box('avc1', Buffer.alloc(8))])), () => target)).toThrow(/count/);
  });
  it.each([0, 1])('rewrites moov/moof/top-level PSSH v%s and preserves offsets, key IDs, other DRM and samples', async version => {
    const drm = pssh({ version });
    const other = pssh({ id: Buffer.alloc(16, 5) });
    const samples = box('mdat', Buffer.concat([Buffer.alloc(64, 9), drm]));
    const input = Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', Buffer.concat([other, drm])), samples, box('moof', drm), drm]);
    const result = rewriteMp4Metadata(input, url => { expect(url).toBe(origin); return target; });
    expect(result.length).toBe(input.length);
    expect(result.indexOf(samples)).toBe(input.indexOf(samples));
    expect(result.indexOf(other)).toBe(input.indexOf(other));
    expect(result.subarray(input.indexOf(drm), input.indexOf(drm) + (version ? 48 : 28))).toEqual(drm.subarray(0, version ? 48 : 28));
    const xml = result.subarray(input.indexOf(drm) + (version ? 62 : 42), input.indexOf(drm) + drm.length).toString('utf16le');
    expect(xml).toContain(`<LA_URL>${target}</LA_URL>`); expect(xml).toContain(key); expect(xml).not.toContain('provider.example');
    expect(await stream(input)).toEqual(result);
  });
  it('supports extended and zero-length metadata and mdat', async () => {
    const metadata = box('moov', pssh({ extended: true }), true);
    expect(await stream(metadata)).toEqual(rewriteMp4Metadata(metadata, () => target));
    const zero = box('moof', pssh()); zero.writeUInt32BE(0);
    expect(await stream(zero)).toEqual(rewriteMp4Metadata(zero, () => target));
    const media = box('mdat', Buffer.from('unchanged')); media.writeUInt32BE(0);
    expect(await stream(media)).toEqual(media);
  });
  it('passes ordinary non-MP4 data without buffering it', async () => {
    const value = Buffer.from('#EXTM3U\nnot mp4'); expect(await stream(value)).toEqual(value);
  });
  it('streams valid MPEG-TS packets whose printable payload resembles an unknown MP4 box', async () => {
    const packet = Buffer.alloc(188, 0xff);
    Buffer.from([0x47, 0x01, 0, 0x10, 0x41, 0x42, 0x43, 0x44]).copy(packet);
    const input = Buffer.concat([packet, packet, packet, packet]);
    expect(await stream(input, { maxMetadataBytes: 512 })).toEqual(input);
    await expect(stream(input, { isMp4: true, maxMetadataBytes: 512 })).rejects.toThrow();
  });
  it('preserves printable AES-128 keys that resemble an incomplete unknown box', async () => {
    const key = Buffer.from('0123abcd45678901');
    expect(await stream(key)).toEqual(key);
    await expect(stream(key, { isMp4: true })).rejects.toThrow();
    const extendedKey = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('abcd'), Buffer.alloc(8, 255)]);
    expect(await stream(extendedKey)).toEqual(extendedKey);
    await expect(stream(extendedKey, { isMp4: true })).rejects.toThrow();
  });
  it.each(['emsg', 'prft', 'zzzz'])('inspects MP4 metadata following an initial %s box', async type => {
    const prefix = box(type, Buffer.alloc(4));
    const input = Buffer.concat([prefix, box('moof', pssh())]);
    const result = await stream(input);
    expect(result).toEqual(rewriteMp4Metadata(input, () => target));
    expect(result.subarray(0, prefix.length)).toEqual(prefix);
    expect(result.toString('utf16le')).not.toContain('provider.example');
  });
  it('fails closed for malformed or incomplete data explicitly identified as MP4', async () => {
    const malformed = box('zzzz', Buffer.alloc(4)); malformed.writeUInt32BE(7);
    await expect(stream(malformed, { isMp4: true })).rejects.toThrow();
    await expect(stream(Buffer.from([0, 0, 0]), { isMp4: true })).rejects.toThrow();
    const extended = box('moov', Buffer.alloc(0), true);
    await expect(stream(extended.subarray(0, 8))).rejects.toThrow();
    extended.writeBigUInt64BE(0n, 8);
    await expect(stream(extended)).rejects.toThrow();
  });
  it('rejects insufficient URL budgets and malformed/truncated metadata before emitting it', async () => {
    const short = pssh({ xml: '<WRMHEADER><DATA><LA_URL>https://a.b</LA_URL></DATA></WRMHEADER>' });
    expect(() => rewriteMp4Metadata(short, () => target)).toThrow(/budget/i);
    const malformed = box('moov', pssh()); malformed.writeUInt32BE(7, 8);
    const truncated = box('moov', pssh()).subarray(0, -1);
    const huge = Buffer.alloc(8); huge.writeUInt32BE(33 * 1024 * 1024); huge.write('moov', 4);
    for (const input of [malformed, truncated, huge]) await expect(stream(input)).rejects.toThrow();
    const bad = pssh(); bad.writeUInt32BE(999999, 28);
    expect(() => rewriteMp4Metadata(bad, () => target)).toThrow();
    const indefinite = box('moov', Buffer.alloc(64)); indefinite.writeUInt32BE(0);
    await expect(stream(indefinite, { maxMetadataBytes: 32 })).rejects.toThrow();
  });
  it('compacts only whitespace between XML tags to fit, and pads with valid XML whitespace', () => {
    const xml = '<WRMHEADER>                 <DATA>                 <LA_URL>https://a.b</LA_URL>                 </DATA>                 </WRMHEADER>';
    const input = pssh({ xml }); const result = rewriteMp4Metadata(input, () => target);
    expect(result.length).toBe(input.length); expect(result.subarray(42).toString('utf16le')).toContain(`<LA_URL>${target}</LA_URL>`);
  });
  it('streams media before EOF and holds an entire metadata container until validation succeeds', async () => {
    const transform = createMp4PrivacyTransform(() => target);
    const output = []; transform.on('data', chunk => output.push(chunk));
    const metadata = box('moov', Buffer.concat([pssh(), pssh()]));
    transform.write(metadata.subarray(0, -1)); expect(output).toHaveLength(0);
    transform.write(metadata.subarray(-1)); expect(Buffer.concat(output).length).toBe(metadata.length);
    const mediaHeader = Buffer.alloc(8); mediaHeader.writeUInt32BE(100000008); mediaHeader.write('mdat', 4);
    transform.write(mediaHeader); transform.write(Buffer.alloc(100, 7));
    expect(Buffer.concat(output).length).toBe(metadata.length + 108);
    // A deliberately unfinished media box must error, never silently appear complete.
    const error = once(transform, 'error'); transform.end(); await expect(error).resolves.toEqual([expect.any(Error)]);
  });
  it('rejects unsafe PlayReady stores, bad KID lists, impossible sizes and truncated headers', async () => {
    const store = pssh(); store.writeUInt16LE(3, 38);
    const kids = pssh({ version: 1 }); kids.writeUInt32BE(0xffffffff, 28);
    const gigantic = box('moov', Buffer.alloc(0), true); gigantic.writeBigUInt64BE(2n ** 63n, 8);
    const ftyp = box('ftyp', Buffer.from('isom0000'));
    for (const value of [store, kids, gigantic, Buffer.concat([ftyp, Buffer.from([0, 0])])]) {
      await expect(stream(value)).rejects.toThrow();
    }
    expect(() => rewriteMp4Metadata(pssh(), () => target, { maxMetadataBytes: Infinity })).toThrow();
  });
  it('limits license grants per complete metadata box and resets for later key rotations', async () => {
    const input = box('moov', Buffer.concat(Array.from({ length: 257 }, () => pssh())));
    let calls = 0;
    expect(() => rewriteMp4Metadata(input, () => { calls++; return target; })).toThrow(/count.*budget/);
    expect(calls).toBe(256);
    const transform = createMp4PrivacyTransform(() => { calls++; return target; });
    const chunks = []; transform.on('data', chunk => chunks.push(chunk));
    calls = 0;
    const error = once(transform, 'error'); transform.end(input);
    await expect(error).resolves.toEqual([expect.any(Error)]);
    expect(calls).toBe(256); expect(chunks).toHaveLength(0);
    const rotation = box('moof', Buffer.concat(Array.from({ length: 256 }, () => pssh())));
    calls = 0;
    const result = rewriteMp4Metadata(Buffer.concat([rotation, rotation]), () => { calls++; return target; });
    expect(result.length).toBe(rotation.length * 2); expect(calls).toBe(512);
  });
});
