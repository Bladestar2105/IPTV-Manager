import { describe, expect, it } from 'vitest';
import { rewritePlayReadyObject, rewritePlayReadyPssh } from '../src/utils/clientPlayReady.js';
import { rewriteHlsManifest } from '../src/utils/clientManifests.js';
import { rewriteDashManifest } from '../src/utils/clientManifests.js';

const systemId = Buffer.from('9a04f07998404286ab92e65be0885f95', 'hex');
const key = '<KID ALGID="AESCTR" CHECKSUM="untouched" VALUE="unchanged"></KID>';
const header = `<WRMHEADER version="4.3.0.0"><DATA><PROTECTINFO><KIDS>${key}</KIDS></PROTECTINFO><LA_URL>https://drm.example/key?a=1&amp;b=secret</LA_URL><LUI_URL>https://drm.example/login</LUI_URL></DATA></WRMHEADER>`;
const map = (url, options) => {
  expect(url).toBe('https://drm.example/key?a=1&b=secret');
  expect(options).toEqual({ kind: 'license' });
  return 'https://manager.example/license?a=1&b=opaque';
};
function object(xml = header) {
  const value = Buffer.from(xml, 'utf16le');
  const result = Buffer.alloc(10 + value.length);
  result.writeUInt32LE(result.length); result.writeUInt16LE(1, 4);
  result.writeUInt16LE(1, 6); result.writeUInt16LE(value.length, 8); value.copy(result, 10);
  return result;
}
function pssh(version = 0, id = systemId) {
  const pro = object();
  const kids = version ? Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.alloc(16, 7)]) : Buffer.alloc(0);
  const result = Buffer.alloc(32 + kids.length + pro.length);
  result.writeUInt32BE(result.length); result.write('pssh', 4); result[8] = version;
  id.copy(result, 12); kids.copy(result, 28);
  result.writeUInt32BE(pro.length, 28 + kids.length); pro.copy(result, 32 + kids.length);
  return result;
}
describe('PlayReady manifest license resources', () => {
  it('rewrites license URLs inside an inline HLS PlayReady PSSH key', () => {
    const output = rewriteHlsManifest(`#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="data:text/plain;base64,${pssh().toString('base64')}"`, 'https://origin/master.m3u8', map);
    const payload = output.match(/base64,([a-z\d+/=]+)/i)[1];
    const xml = Buffer.from(payload, 'base64').subarray(42).toString('utf16le');
    expect(xml).toContain(key);
    expect(xml).toContain('https://manager.example/license');
    expect(xml).not.toContain('drm.example');
  });
  it('rewrites UTF16 license URL, removes interactive URL and preserves key material', () => {
    const result = Buffer.from(rewritePlayReadyObject(object().toString('base64'), map), 'base64');
    expect(result.readUInt32LE()).toBe(result.length);
    expect(result.readUInt16LE(8)).toBe(result.length - 10);
    const xml = result.subarray(10).toString('utf16le');
    expect(xml).toContain(key);
    expect(xml).toContain('<LA_URL>https://manager.example/license?a=1&amp;b=opaque</LA_URL>');
    expect(xml).not.toMatch(/drm\.example|LUI_URL/);
  });
  it.each([0, 1])('rebuilds version %s PSSH sizes without changing flags, system ID or KIDs', version => {
    const input = pssh(version);
    const result = Buffer.from(rewritePlayReadyPssh(input.toString('base64'), map), 'base64');
    const offset = version ? 48 : 28;
    expect(result.subarray(4, offset)).toEqual(input.subarray(4, offset));
    expect(result.readUInt32BE()).toBe(result.length);
    expect(result.readUInt32BE(offset)).toBe(result.length - offset - 4);
    expect(result.subarray(offset + 14).toString('utf16le')).toContain(key);
  });
  it('leaves non-PlayReady PSSH unchanged', () => {
    const other = pssh(0, Buffer.alloc(16, 3)).toString('base64');
    expect(rewritePlayReadyPssh(other, () => { throw new Error('must not map'); })).toBe(other);
  });
  it('preserves unknown records byte for byte', () => {
    const pro = object();
    const extra = Buffer.from([4, 0, 3, 0, 9, 8, 7]);
    const input = Buffer.concat([pro, extra]); input.writeUInt32LE(input.length); input.writeUInt16LE(2, 4);
    const output = Buffer.from(rewritePlayReadyObject(input.toString('base64'), map), 'base64');
    expect(output.subarray(-extra.length)).toEqual(extra);
  });
  it('accepts empty XML elements from common serializers without changing keys', () => {
    const shortKey = '<KID ALGID="AESCTR" CHECKSUM="untouched" VALUE="unchanged"/>';
    const xml = header.replace(key, shortKey).replace('</DATA>', '<CUSTOMATTRIBUTES xmlns=""/></DATA>');
    const result = Buffer.from(rewritePlayReadyObject(object(xml).toString('base64'), map), 'base64').subarray(10).toString('utf16le');
    expect(result).toContain(shortKey);
    expect(result).toContain('<CUSTOMATTRIBUTES xmlns=""/>');
    expect(result).not.toContain('drm.example');
  });
  it('rewrites both embedded PlayReady forms through the DASH renderer', () => {
    const input = `<MPD><ContentProtection><mspr:pro>${object().toString('base64')}</mspr:pro><cenc:pssh>${pssh(1).toString('base64')}</cenc:pssh></ContentProtection></MPD>`;
    const result = rewriteDashManifest(input, 'https://origin/manifest.mpd', map);
    const pro = Buffer.from(result.match(/<mspr:pro>(.*?)<\/mspr:pro>/)[1], 'base64');
    const box = Buffer.from(result.match(/<cenc:pssh>(.*?)<\/cenc:pssh>/)[1], 'base64');
    for (const xml of [pro.subarray(10).toString('utf16le'), box.subarray(62).toString('utf16le')]) {
      expect(xml).toContain('<LA_URL>https://manager.example/license?a=1&amp;b=opaque</LA_URL>');
      expect(xml).toContain(key);
      expect(xml).not.toMatch(/drm\.example|LUI_URL/);
    }
  });
  it('rejects malformed, unsafe and oversized recognized data', () => {
    const truncated = object().subarray(0, -1);
    const badBox = pssh(); badBox.writeUInt32BE(999999, 28);
    for (const input of [truncated, Buffer.from([1, 2, 3]), object(header.replace('</DATA>', '</OTHER>')), object(header.replace('https://drm.example/key?a=1&amp;b=secret', 'file:///secret')), object(header.replace('<DATA>', '<!DOCTYPE x><DATA>'))]) {
      expect(() => rewritePlayReadyObject(input.toString('base64'), map)).toThrow();
    }
    expect(() => rewritePlayReadyPssh(badBox.toString('base64'), map)).toThrow();
    expect(() => rewritePlayReadyObject(object().toString('base64'), () => 'https://manager/' + 'x'.repeat(16000))).toThrow();
    expect(() => rewritePlayReadyObject('!not-base64!', map)).toThrow();
  });
  it('rejects embedded license stores and truncated version-one KID lists', () => {
    const pro = object(); pro.writeUInt16LE(3, 6);
    expect(() => rewritePlayReadyObject(pro.toString('base64'), map)).toThrow();
    const box = pssh(1); box.writeUInt32BE(0xffffffff, 28);
    expect(() => rewritePlayReadyPssh(box.toString('base64'), map)).toThrow();
  });
});
