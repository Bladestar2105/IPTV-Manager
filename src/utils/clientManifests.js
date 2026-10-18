import { rewritePlayReadyObject, rewritePlayReadyPssh } from './clientPlayReady.js';

// Resolve every playable resource before mapping it to an opaque Manager URL.
function resolveResource(value, baseUrl) {
  const url = new URL(value, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported manifest resource protocol');
  return url.href;
}

function inlineHlsKey(uri, mapUrl) {
  const match = uri.length <= 131072 && uri.match(/^(data:(?:(?:text\/plain|application\/octet-stream)(?:;charset=[\w-]+)?)?;base64,)([a-z\d+/]+={0,2})$/i);
  if (!match) throw new Error('Unsupported inline HLS key');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) throw new Error('Invalid inline HLS key');
  if (bytes.length === 16) return uri;
  if (bytes.length < 32 || bytes.readUInt32BE(0) !== bytes.length || bytes.toString('ascii', 4, 8) !== 'pssh') throw new Error('Unsupported inline HLS key');
  const system = bytes.subarray(12, 28).toString('hex');
  if (system === '9a04f07998404286ab92e65be0885f95') return match[1] + rewritePlayReadyPssh(match[2], mapUrl);
  const offset = bytes[8] === 1 ? 32 + bytes.readUInt32BE(28) * 16 : 28;
  if (system !== 'edef8ba979d64acea3c827dcd51d21ed' || bytes[8] > 1 || offset + 4 > bytes.length ||
      bytes.readUInt32BE(offset) !== bytes.length - offset - 4 || /(?:https?|ftp|rtsp|rtmp):\/\//i.test(bytes.toString('latin1').replace(/\0/g, ''))) throw new Error('Unsupported inline HLS key');
  return uri;
}

export function rewriteHlsManifest(text, baseUrl, mapUrl, inheritedVariables = {}) {
  if ([...text.matchAll(/\bCODECS\s*=\s*(["'])(.*?)\1/gi)].some(match => /stpp|ttml/i.test(match[2]))) throw new Error('Unsupported HLS TTML');
  const variables = {};
  const expand = value => value.replace(/\{\$([\w-]+)\}/g, (_match, name) => {
    if (!Object.hasOwn(variables, name)) throw new Error('Undefined HLS variable');
    return variables[name];
  });
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-DEFINE:')) continue;
    const attrs = Object.fromEntries([...line.matchAll(/([A-Z-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    if (attrs.IMPORT) {
      if (!Object.hasOwn(inheritedVariables, attrs.IMPORT)) throw new Error('Undefined imported HLS variable');
      variables[attrs.IMPORT] = inheritedVariables[attrs.IMPORT];
    } else if (attrs.QUERYPARAM) {
      const value = new URL(baseUrl).searchParams.get(attrs.QUERYPARAM);
      if (value === null) throw new Error('Missing HLS query variable');
      variables[attrs.QUERYPARAM] = value;
    } else if (attrs.NAME && attrs.VALUE !== undefined) variables[attrs.NAME] = expand(attrs.VALUE);
  }
  const rewrite = (value, options = {}, key = false) => {
    const expanded = expand(value);
    if (key && /^data:/i.test(expanded)) return inlineHlsKey(expanded, mapUrl);
    const url = resolveResource(expanded, baseUrl);
    const context = { ...(Object.keys(variables).length ? { hlsVariables: variables } : {}), ...options };
    return Object.keys(context).length ? mapUrl(url, context) : mapUrl(url);
  };
  let variant = false;
  return text.split(/(\r?\n)/).map(line => {
    if (!line.trim() || /^\r?\n$/.test(line)) return line;
    // Steering host substitution would redirect opaque Manager URLs to a CDN.
    if (line.startsWith('#EXT-X-DEFINE:') || line.startsWith('#EXT-X-CONTENT-STEERING:')) return '';
    if (!line.startsWith('#')) {
      const result = rewrite(line.trim(), variant ? { manifestKind: 'hls' } : {});
      variant = false;
      return result;
    }
    if (!/^#EXT(?:M3U|INF|-[A-Z0-9-]+)(?::|$)/.test(line)) return '';
    if (line.startsWith('#EXT-X-SESSION-DATA:') && /(?:^|,)VALUE\s*=/.test(line.slice(line.indexOf(':') + 1))) return '';
    if (line.startsWith('#EXT-X-DATERANGE:')) {
      const attributes = line.slice(line.indexOf(':') + 1).match(/(?:[^,"']|"[^"]*"|'[^']*')+/g) || [];
      return '#EXT-X-DATERANGE:' + attributes.flatMap(attribute => {
        const match = attribute.match(/^\s*([A-Z0-9-]+)\s*=\s*(["'])(.*?)\2\s*$/);
        if (match && ['X-ASSET-LIST', 'X-ASSET-URI'].includes(match[1])) {
          const options = match[1] === 'X-ASSET-URI' ? { manifestKind: 'hls' } : {};
          return [`${match[1]}=${match[2]}${rewrite(match[3], options)}${match[2]}`];
        }
        if (/^\s*X-/i.test(attribute) && /(?:https?:)?\/\//i.test(attribute)) return [];
        return [attribute];
      }).join(',');
    }
    if (/^#EXTINF:/.test(line) && /(?:https?:)?\/\//i.test(line)) return line.slice(0, line.indexOf(',') + 1);
    if (line.startsWith('#EXT-X-STREAM-INF:')) variant = true;
    const playlist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|IMAGE-STREAM-INF|RENDITION-REPORT):/.test(line);
    const key = /^#EXT-X-(?:SESSION-)?KEY:/.test(line) && !/\bMETHOD=NONE(?:,|$)/.test(line);
    return line.replace(/(\b(?:URI|SERVER-URI)\s*=\s*)(["'])(.*?)\2/g, (_match, prefix, quote, uri) => `${prefix}${quote}${rewrite(uri, playlist ? { manifestKind: 'hls' } : {}, key)}${quote}`);
  }).join('');
}

const decodeXml = value => value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&(?:amp|quot|apos|lt|gt|#x[\da-f]+|#\d+);/gi, entity => {
  const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (names[entity]) return names[entity];
  return String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
});
const encodeXml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
const localName = name => name.split(':').pop();

export function rewriteDashManifest(text, baseUrl, mapUrl, alternativeBases = []) {
  const resolveChoices = (values, bases) => {
    const urls = new Set();
    for (const value of values) for (const base of bases) {
      urls.add(resolveResource(decodeXml(value.trim()), base));
      if (urls.size > 64) throw new Error('Too many DASH resource alternatives');
    }
    return [...urls];
  };
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported DASH XML declaration');
  text = text.replace(/<\?xml-stylesheet\b[\s\S]*?\?>/gi, '');
  if (/<\?(?!xml\s)[\s\S]*?\?>/i.test(text)) throw new Error('Unsupported DASH processing instruction');
  const root = { children: [] };
  const stack = [root];
  const tokens = text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (/^<\//.test(token)) {
      if (stack.length < 2) throw new Error('Invalid DASH XML');
      stack.pop().close = token;
    } else if (/^<[\w]/.test(token)) {
      const name = token.match(/^<([^\s/>]+)/)[1];
      const node = { name, open: token, close: '', children: [] };
      stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
    } else stack.at(-1).children.push(token);
  }
  if (stack.length !== 1) throw new Error('Invalid DASH XML');
  // Absolute grants must use each representation's effective BaseURL, including
  // descriptors inherited from Period/AdaptationSet and partial overrides.
  const segmentNames = new Set(['SegmentTemplate', 'SegmentList', 'SegmentBase']);
  const hasRepresentations = node => typeof node !== 'string' &&
    (localName(node.name || '') === 'Representation' || node.children.some(hasRepresentations));
  const inheritSegments = (node, inherited) => {
    if (typeof node === 'string') return;
    const descriptors = node.children.filter(child => typeof child !== 'string' && segmentNames.has(localName(child.name)));
    if (descriptors.length > 1) {
      for (const child of node.children) inheritSegments(child);
      return;
    }
    const own = descriptors[0];
    let effective = own ? structuredClone(own) : inherited;
    if (own && inherited && localName(own.name) === localName(inherited.name)) {
      const attributes = value => [...value.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], `${match[1]}=${match[2]}${match[3]}${match[2]}`]);
      const merged = new Map([...attributes(inherited.open), ...attributes(own.open)]);
      effective.open = `<${own.name} ${[...merged.values()].join(' ')}>`;
      effective.close = `</${own.name}>`;
      const ownNames = new Set(own.children.filter(child => typeof child !== 'string').map(child => localName(child.name)));
      effective.children = [...structuredClone(inherited.children).filter(child => typeof child !== 'string' && !ownNames.has(localName(child.name))), ...effective.children];
    }
    if (localName(node.name || '') === 'Representation' && effective) {
      node.children = node.children.filter(child => typeof child === 'string' || !segmentNames.has(localName(child.name)));
      node.children.push(structuredClone(effective));
      if (/\/\s*>$/.test(node.open)) {
        node.open = node.open.replace(/\/\s*>$/, '>');
        node.close = `</${node.name}>`;
      }
    } else if (hasRepresentations(node)) {
      node.children = node.children.filter(child => typeof child === 'string' || !segmentNames.has(localName(child.name)));
    }
    for (const child of node.children) inheritSegments(child, effective);
  };
  inheritSegments(root);
  const rewrite = (value, base, options = {}) => {
    const [url, ...alternatives] = resolveChoices([value], base);
    return mapUrl(url, { ...(alternatives.length ? { alternatives } : {}), template: /\$(?:RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0?\d+d)?\$/.test(url), ...options });
  };
  const render = (node, inheritedBase) => {
    if (typeof node === 'string') return node;
    const name = localName(node.name || '');
    const scheme = decodeXml(node.open?.match(/\bschemeIdUri\s*=\s*(["'])(.*?)\1/)?.[2] || '').trim();
    const codecs = decodeXml(node.open?.match(/\bcodecs\s*=\s*(["'])(.*?)\1/)?.[2] || '');
    const mime = decodeXml(node.open?.match(/\bmimeType\s*=\s*(["'])(.*?)\1/)?.[2] || '');
    if (/stpp|ttml/i.test(`${codecs} ${mime}`)) {
      if (['AdaptationSet', 'Representation', 'SubRepresentation'].includes(name)) return '';
      throw new Error('Unsupported DASH TTML declaration');
    }
    const httpTiming = /^urn:mpeg:dash:utc:http-(?:head|iso|xsdate):\d{4}$/.test(scheme);
    if (name === 'UTCTiming' && scheme && !httpTiming && !/^urn:mpeg:dash:utc:direct:\d{4}$/.test(scheme)) return '';
    if (['ContentSteering', 'Metrics', 'Reporting'].includes(name)) return '';
    if (['EventStream', 'InbandEventStream'].includes(name) && scheme === 'urn:mpeg:dash:event:callback:2015') return '';
    if (['EssentialProperty', 'SupplementalProperty'].includes(name) && /^urn:mpeg:dash:urlparam:201[46]$/.test(scheme)) {
      if (name === 'EssentialProperty') throw new Error('Unsupported required DASH URL query extension');
      return '';
    }
    if (['UrlQueryInfo', 'ExtUrlQueryInfo'].includes(name)) throw new Error('Unsupported DASH URL query extension');
    const xmlBase = node.open?.match(/\bxml:base\s*=\s*(["'])(.*?)\1/);
    const nodeBase = xmlBase ? resolveChoices([xmlBase[2]], inheritedBase) : inheritedBase;
    const baseTexts = node.children.filter(child => typeof child !== 'string' && localName(child.name) === 'BaseURL')
      .map(child => child.children.filter(value => typeof value === 'string').join('')).filter(value => value.trim());
    const base = baseTexts.length ? resolveChoices(baseTexts, nodeBase) : nodeBase;
    node.open = node.open?.replace(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g, (match, attr, quote, value) => {
      if (attr === 'xml:base') return '';
      // DASH uses this XLink value to remove an element without a network fetch.
      if (attr === 'xlink:href' && decodeXml(value.trim()) === 'urn:mpeg:dash:resolve-to-zero:2013') return match;
      if (name === 'UTCTiming' && attr === 'value' && (httpTiming || /^(?:https?:)?\/\//i.test(decodeXml(value.trim())))) {
        return `${attr}=${quote}${encodeXml(decodeXml(value.trim()).split(/\s+/).map(url => rewrite(url, base)).join(' '))}${quote}`;
      }
      if (['media', 'initialization', 'bitstreamSwitching', 'sourceURL', 'index', 'href', 'licenseUrl', 'licenseURL', 'licenseUri', 'licenseURI'].includes(localName(attr)) || (scheme === 'urn:dvb:dash:fontdownload:2014' && localName(attr) === 'url')) {
        return `${attr}=${quote}${encodeXml(rewrite(value, base, attr === 'xlink:href' ? { manifestKind: 'dash' } : /^license(?:Url|URL|Uri|URI)$/.test(localName(attr)) ? { kind: 'license' } : {}))}${quote}`;
      }
      return match;
    });
    if (name === 'pro' || name === 'pssh') {
      const value = node.children.filter(child => typeof child === 'string').join('');
      const rewriteDrm = name === 'pro' ? rewritePlayReadyObject : rewritePlayReadyPssh;
      return node.open + rewriteDrm(decodeXml(value.trim()), mapUrl) + node.close;
    }
    if (['BaseURL', 'Location', 'PatchLocation', 'Laurl', 'laurl'].includes(name)) {
      const value = node.children.filter(child => typeof child === 'string').join('');
      if (!value.trim()) return node.open + node.close;
      return node.open + encodeXml(rewrite(value, nodeBase, /^(?:Laurl|laurl)$/.test(name) ? { kind: 'license' } : ['Location', 'PatchLocation'].includes(name) ? { manifestKind: 'dash' } : {})) + node.close;
    }
    const children = node.children.map(child => render(child, typeof child !== 'string' && localName(child.name) === 'BaseURL' ? nodeBase : base));
    const representations = node.children.flatMap((child, index) => typeof child !== 'string' && localName(child.name) === 'Representation' ? [children[index]] : []);
    if (name === 'AdaptationSet' && representations.length && !representations.some(Boolean)) return '';
    return (node.open || '') + children.join('') + (node.close || '');
  };
  return render(root, [baseUrl, ...alternativeBases]);
}

export function isClientManifest(contentType = '', url = '') {
  if (/mpegurl/i.test(contentType) || /\.m3u8?(?:[?#]|$)/i.test(url)) return 'hls';
  if (/dash\+xml/i.test(contentType) || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  return null;
}
