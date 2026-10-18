import { rewritePlayReadyObject, rewritePlayReadyPssh } from './clientPlayReady.js';

// Resolve every playable resource before mapping it to an opaque Manager URL.
function resolveResource(value, baseUrl) {
  if (/^data:/i.test(value)) return value;
  const url = new URL(value, baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported manifest resource protocol');
  return url.href;
}

export function rewriteHlsManifest(text, baseUrl, mapUrl, inheritedVariables = {}) {
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
  const rewrite = value => {
    const url = resolveResource(expand(value), baseUrl);
    return /^data:/i.test(url) ? url : (Object.keys(variables).length ? mapUrl(url, { hlsVariables: variables }) : mapUrl(url));
  };
  return text.split(/(\r?\n)/).map(line => {
    if (!line.trim() || /^\r?\n$/.test(line)) return line;
    // Steering host substitution would redirect opaque Manager URLs to a CDN.
    if (line.startsWith('#EXT-X-DEFINE:') || line.startsWith('#EXT-X-CONTENT-STEERING:')) return '';
    if (!line.startsWith('#')) return rewrite(line.trim());
    return line.replace(/(\b(?:URI|SERVER-URI)\s*=\s*)(["'])(.*?)\2/g, (_match, prefix, quote, uri) => `${prefix}${quote}${rewrite(uri)}${quote}`);
  }).join('');
}

const decodeXml = value => value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&(?:amp|quot|apos|lt|gt|#x[\da-f]+|#\d+);/gi, entity => {
  const names = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
  if (names[entity]) return names[entity];
  return String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
});
const encodeXml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/</g, '&lt;');
const localName = name => name.split(':').pop();

export function rewriteDashManifest(text, baseUrl, mapUrl) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Unsupported DASH XML declaration');
  const root = { children: [] };
  const stack = [root];
  const tokens = text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+/g) || [];
  for (const token of tokens) {
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
  const rewrite = (value, base, options = {}) => {
    const url = resolveResource(decodeXml(value.trim()), base);
    return /^data:/i.test(url) ? url : mapUrl(url, { template: /\$(?:RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0?\d+d)?\$/.test(url), ...options });
  };
  const render = (node, inheritedBase) => {
    if (typeof node === 'string') return node;
    if (localName(node.name || '') === 'ContentSteering') return '';
    const xmlBase = node.open?.match(/\bxml:base\s*=\s*(["'])(.*?)\1/);
    const nodeBase = xmlBase ? resolveResource(decodeXml(xmlBase[2]), inheritedBase) : inheritedBase;
    const baseNode = node.children.find(child => typeof child !== 'string' && localName(child.name) === 'BaseURL');
    const baseText = baseNode?.children.filter(child => typeof child === 'string').join('');
    const base = baseText ? resolveResource(decodeXml(baseText.trim()), nodeBase) : nodeBase;
    node.open = node.open?.replace(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g, (match, attr, quote, value) => {
      if (attr === 'xml:base') return '';
      // DASH uses this XLink value to remove an element without a network fetch.
      if (attr === 'xlink:href' && decodeXml(value.trim()) === 'urn:mpeg:dash:resolve-to-zero:2013') return match;
      if (['media', 'initialization', 'sourceURL', 'index', 'href', 'licenseUrl', 'licenseURL', 'licenseUri', 'licenseURI'].includes(localName(attr)) || (localName(node.name) === 'UTCTiming' && attr === 'value' && /^(?:https?:)?\/\//i.test(value))) {
        return `${attr}=${quote}${encodeXml(rewrite(value, base, attr === 'xlink:href' ? { manifestKind: 'dash' } : /^license(?:Url|URL|Uri|URI)$/.test(localName(attr)) ? { kind: 'license' } : {}))}${quote}`;
      }
      return match;
    });
    const name = localName(node.name || '');
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
    return (node.open || '') + node.children.map(child => render(child, typeof child !== 'string' && localName(child.name) === 'BaseURL' ? nodeBase : base)).join('') + (node.close || '');
  };
  return render(root, baseUrl);
}

export function isClientManifest(contentType = '', url = '') {
  if (/mpegurl/i.test(contentType) || /\.m3u8?(?:[?#]|$)/i.test(url)) return 'hls';
  if (/dash\+xml/i.test(contentType) || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  return null;
}
