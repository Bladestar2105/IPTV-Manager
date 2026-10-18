const TT = new Set(['http://www.w3.org/ns/ttml', 'http://www.w3.org/2006/10/ttaf1']);
const STYLING = 'http://www.w3.org/ns/ttml#styling';
const PARAMETER = 'http://www.w3.org/ns/ttml#parameter';
const METADATA = 'http://www.w3.org/ns/ttml#metadata';
const XML = 'http://www.w3.org/XML/1998/namespace';
const namespaces = new Set([...TT, STYLING, PARAMETER, METADATA, XML]);
const elements = new Set('tt head metadata styling style layout region body div p span br'.split(' '));
const attributes = new Set('style region begin end dur timeContainer'.split(' '));
const styles = new Set('backgroundColor color direction display displayAlign extent fontFamily fontSize fontStyle fontWeight lineHeight opacity origin overflow padding showBackground textAlign textDecoration textOutline unicodeBidi visibility wrapOption writingMode zIndex ruby rubyAlign rubyPosition textCombine textEmphasis textOrientation multiRowAlign linePadding fillLineGap'.split(' '));
const parameters = new Set('timeBase clockMode frameRate frameRateMultiplier subFrameRate tickRate dropMode markerMode cellResolution pixelAspectRatio displayAspectRatio version'.split(' '));
const invalid = () => { throw new Error('Unsupported TTML resource'); };

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, '').includes('&')) invalid();
  return value.replace(/&([^;]+);/g, (_match, entity) => {
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(code) || code > 0x10ffff || code < 0x20 && ![9, 10, 13].includes(code) || code >= 0xd800 && code <= 0xdfff) invalid();
    return String.fromCodePoint(code);
  });
}

// Static text/layout only: image, font, link and external styling extensions fail closed.
export function validateClientTtml(text) {
  if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]/.test(text)) invalid();
  let xml = text.replace(/^\uFEFF/, '').trim();
  xml = xml.replace(/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-?8"|'UTF-?8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>\s*/i, '');
  if (xml.includes('<?')) invalid();
  const tokens = xml.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:"[^"<>]*"|'[^'<>]*'|[^'"<>])*)>|[^<]+/g) || [];
  if (tokens.join('') !== xml) invalid();
  const stack = [];
  let roots = 0;
  for (const token of tokens) {
    if (token.startsWith('<!--')) {
      if (token.slice(4, -3).includes('--')) invalid();
      continue;
    }
    if (token.startsWith('<![CDATA[')) { if (!stack.length) invalid(); continue; }
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) invalid();
      decodeEntities(token);
      continue;
    }
    const close = token.match(/^<\/([\w:.-]+)\s*>$/);
    if (close) { if (stack.pop()?.name !== close[1]) invalid(); continue; }
    const open = token.match(/^<([\w:.-]+)([\s\S]*?)(\/?)>$/);
    if (!open || stack.length >= 64) invalid();
    const bindings = { ...(stack.at(-1)?.bindings || {}), xml: XML };
    const fields = [];
    const seen = new Set();
    let rest = open[2];
    while (rest.trim()) {
      const field = rest.match(/^\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/s);
      if (!field || seen.has(field[1])) invalid();
      seen.add(field[1]);
      const value = decodeEntities(field[3]);
      if (field[1] === 'xmlns' || field[1].startsWith('xmlns:')) {
        if (!namespaces.has(value)) invalid();
        bindings[field[1] === 'xmlns' ? '' : field[1].slice(6)] = value;
      } else fields.push([field[1], value]);
      rest = rest.slice(field[0].length);
    }
    const parts = open[1].split(':');
    if (parts.length > 2) invalid();
    const local = parts.at(-1);
    const namespace = bindings[parts.length === 2 ? parts[0] : ''];
    if (parts.length === 2 && !namespace || namespace && !TT.has(namespace) && namespace !== METADATA) invalid();
    if (namespace === METADATA ? !['title', 'desc', 'copyright'].includes(local) : !elements.has(local)) invalid();
    if (!stack.length && (++roots !== 1 || local !== 'tt' || namespace === METADATA)) invalid();
    for (const [name, value] of fields) {
      const names = name.split(':');
      if (names.length > 2) invalid();
      const attr = names.at(-1);
      const ns = names.length === 2 ? bindings[names[0]] : null;
      if (names.length === 2 && !ns) invalid();
      if (ns === PARAMETER && ['profile', 'contentProfiles', 'processorProfiles'].includes(attr)) {
        if (!value.split(/\s+/).every(profile => /^http:\/\/www\.w3\.org\/ns\/ttml\/profile\/(?:imsc1(?:\.[12])?\/text|dfxp-(?:presentation|transformation|full))$/.test(profile))) invalid();
        continue;
      }
      if (/url\s*\(|@import|\\|(?:https?|data|file):|\/\//i.test(value)) invalid();
      if (!(ns === XML && ['id', 'lang', 'space'].includes(attr) || ns === STYLING && styles.has(attr) || ns === PARAMETER && parameters.has(attr) || !ns && attributes.has(attr))) invalid();
    }
    if (!open[3]) stack.push({ name: open[1], bindings });
  }
  if (stack.length || roots !== 1) invalid();
  return text;
}
