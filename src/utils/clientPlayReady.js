const PLAYREADY_ID = '9a04f07998404286ab92e65be0885f95';
const MAX_OBJECT = 15 * 1024;
const MAX_PSSH = 1024 * 1024;
const invalid = () => { throw new Error('Unsupported PlayReady license data'); };

function decodeBase64(value, limit) {
  if (typeof value !== 'string' || value.length > limit * 2) invalid();
  const normalized = value.replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) invalid();
  const body = Buffer.from(normalized, 'base64');
  if (body.length > limit || body.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) invalid();
  return body;
}

function validateXml(xml) {
  const stack = [];
  const tokens = xml.match(/<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g) || [];
  if (tokens.join('') !== xml) invalid();
  for (const token of tokens) {
    if (!token.startsWith('<')) continue;
    const close = token.match(/^<\/([\w:.-]+)\s*>$/);
    if (close) {
      if (stack.pop() !== close[1]) invalid();
      continue;
    }
    const open = token.match(/^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>$/);
    if (!open) invalid();
    if (!open[3]) stack.push(open[1]);
  }
  if (stack.length) invalid();
}

function rewriteHeader(body, mapUrl) {
  if (body.length % 2) invalid();
  const xml = body.toString('utf16le');
  if (!Buffer.from(xml, 'utf16le').equals(body) || /<!|<\?|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml) ||
      !/^\s*<WRMHEADER\b[^>]*>[\s\S]*<\/WRMHEADER>\s*$/.test(xml)) invalid();
  validateXml(xml);
  const tag = /<((?:[\w.-]+:)?(?:LA_URL|LUI_URL))\s*>([^<]*)<\/\1\s*>/g;
  if (/<(?:[\w.-]+:)?(?:LA_URL|LUI_URL)\b/.test(xml.replace(tag, ''))) invalid();
  const rewritten = xml.replace(tag, (_match, name, text) => {
    // Non-silent acquisition is an interactive external webpage, not a license relay.
    if (name.split(':').pop() === 'LUI_URL') return '';
    const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const decoded = text.replace(/&([^;]+);/g, (_entity, entity) => {
      if (Object.hasOwn(names, entity)) return names[entity];
      if (/^#x[\da-f]+$/i.test(entity)) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (/^#\d+$/.test(entity)) return String.fromCodePoint(Number(entity.slice(1)));
      return invalid();
    }).trim();
    if (!/^https?:\/\//i.test(decoded) || /[\r\n\u0000]/.test(decoded)) invalid();
    const url = new URL(decoded);
    const mapped = mapUrl(url.href, { kind: 'license' });
    if (typeof mapped !== 'string' || !/^https?:\/\//i.test(mapped) || /[\r\n\u0000]/.test(mapped)) invalid();
    const escaped = mapped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<${name}>${escaped}</${name}>`;
  });
  return Buffer.from(rewritten, 'utf16le');
}

function rewriteObject(body, mapUrl) {
  if (body.length < 6 || body.length > MAX_OBJECT || body.readUInt32LE(0) !== body.length) invalid();
  const count = body.readUInt16LE(4);
  const records = [];
  let offset = 6;
  let headers = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > body.length) invalid();
    const type = body.readUInt16LE(offset);
    const length = body.readUInt16LE(offset + 2);
    if (offset + 4 + length > body.length || type === 3) invalid();
    const original = body.subarray(offset + 4, offset + 4 + length);
    const value = type === 1 ? rewriteHeader(original, mapUrl) : original;
    if (type === 1) headers++;
    if (value.length > MAX_OBJECT) invalid();
    const record = Buffer.alloc(4);
    record.writeUInt16LE(type); record.writeUInt16LE(value.length, 2);
    records.push(record, value);
    offset += 4 + length;
  }
  if (offset !== body.length || headers !== 1) invalid();
  const prefix = Buffer.alloc(6);
  prefix.writeUInt16LE(count, 4);
  const result = Buffer.concat([prefix, ...records]);
  if (result.length > MAX_OBJECT) invalid();
  result.writeUInt32LE(result.length);
  return result;
}

export function rewritePlayReadyObject(base64, mapUrl) {
  return rewriteObject(decodeBase64(base64, MAX_OBJECT), mapUrl).toString('base64');
}

export function rewritePlayReadyPssh(base64, mapUrl) {
  const body = decodeBase64(base64, MAX_PSSH);
  if (body.length < 32 || body.toString('ascii', 4, 8) !== 'pssh' || body.readUInt32BE(0) !== body.length) invalid();
  if (body.subarray(12, 28).toString('hex') !== PLAYREADY_ID) return base64;
  const version = body[8];
  if (version > 1) invalid();
  let offset = 28;
  if (version === 1) {
    if (body.length < 36) invalid();
    offset += 4 + body.readUInt32BE(28) * 16;
  }
  if (offset + 4 > body.length || body.readUInt32BE(offset) !== body.length - offset - 4) invalid();
  const pro = rewriteObject(body.subarray(offset + 4), mapUrl);
  const prefix = Buffer.from(body.subarray(0, offset + 4));
  prefix.writeUInt32BE(pro.length, offset);
  const result = Buffer.concat([prefix, pro]);
  result.writeUInt32BE(result.length);
  return result.toString('base64');
}
