import ISO6391 from 'iso-639-1';
import { LOCALES as NUMBER_LOCALES, ToNumbers } from 'to-numbers';

// Optimization: Pre-compile regex patterns to avoid re-compilation on every match
export const CHANNEL_NAME_PATTERNS = [
  // "| DE | Arte", "[EN] CNN", "|FR| TF1", "(DE) RTL", "┃DE┃ SKY"
  // Added unicode ranges for Box Drawing (\u2500-\u257F), Block Elements (\u2580-\u259F), Geometric Shapes (\u25A0-\u25FF)
  /^[\|\-_\.\[\]\(\)\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]+\s*([A-Z]{2,3})\s*[\-_\.\|:\]\)\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]+\s*(.+)$/i,

  // "DE: Arte", "EN: CNN", "DE| RTL", "DE - RTL", "DE┃ RTL"
  /^([A-Z]{2,3})\s*[\-_\.\|:\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]\s*(.+)$/i,

  // "Arte HD DE", "CNN INT", "Eurosport 1 FR"
  /^(.+?)\s+([A-Z]{2,3})$/i,

  // "Arte (German)", "CNN (EN)", "Eurosport 1 [ENG]"
  // Fixed regex: removed extra backslashes to correctly match parenthesis
  /^(.+?)\s*[\(\[]([^\)\]]+)[\)\]]$/i,

  // "Arte_DE", "CNN-INT", "Eurosport1.FR", "DE| RTL", "Arte┃DE"
  /^(.+?)[\-_\.\|\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]([A-Z]{2,3})$/i,

  // "DE: Arte", "EN: CNN", "DE| RTL"
  /^([A-Z]{2,3})[\-_\.\|:\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]\s*(.+)$/i,
];

// Optimization: Pre-compute language map once
function getISO6392Code(iso6391Code) {
  // Mapping für häufige Codes
  const mapping = {
    'de': 'deu', 'en': 'eng', 'fr': 'fra', 'es': 'spa',
    'it': 'ita', 'pt': 'por', 'nl': 'nld', 'pl': 'pol',
    'tr': 'tur', 'ar': 'ara', 'ru': 'rus', 'zh': 'zho',
    'ja': 'jpn', 'ko': 'kor', 'el': 'gre' // el=Greek
  };
  return mapping[iso6391Code];
}

export const LANGUAGE_MAP = (() => {
  const map = {};
  const allCodes = ISO6391.getAllCodes(); // ['de', 'en', 'fr', ...]

  allCodes.forEach(code => {
    const name = ISO6391.getName(code); // 'German', 'English', ...
    const native = ISO6391.getNativeName(code); // 'Deutsch', 'English', ...

    // Alle Varianten speichern
    map[code.toLowerCase()] = code; // 'de' -> 'de'
    if (name) map[name.toLowerCase()] = code; // 'german' -> 'de'
    if (native) map[native.toLowerCase()] = code; // 'deutsch' -> 'de'

    // ISO 639-2 (3-Buchstaben)
    const code2 = getISO6392Code(code);
    if (code2) {
      map[code2.toLowerCase()] = code; // 'ger', 'deu' -> 'de'
    }
  });

  // Zusätzliche Custom-Mappings für gängige Varianten
  map['eng'] = 'en';
  map['ger'] = 'de';
  map['deu'] = 'de';
  map['fra'] = 'fr';
  map['fre'] = 'fr';
  map['esp'] = 'es';
  map['spa'] = 'es';
  map['int'] = 'int'; // Keep distinct to prevent mismatching with specific regions
  map['uk'] = 'uk'; // Keep distinct
  map['us'] = 'us'; // Keep distinct
  map['usa'] = 'us'; // USA = us
  map['gr'] = 'el'; // GR -> Greek (el)
  map['greece'] = 'el';
  map['greek'] = 'el';

  // Zusätzliche Ländercodes, die oft in EPG IDs (z.B. .at, .ch) oder IPTV Namen (| AT |) auftauchen
  map['at'] = 'at'; // Austria
  map['ch'] = 'ch'; // Switzerland
  map['be'] = 'be'; // Belgium
  map['nl'] = 'nl'; // Netherlands
  map['au'] = 'au'; // Australia
  map['nz'] = 'nz'; // New Zealand
  map['ca'] = 'ca'; // Canada
  map['za'] = 'za'; // South Africa
  map['ie'] = 'ie'; // Ireland
  map['se'] = 'se'; // Sweden
  map['no'] = 'no'; // Norway
  map['dk'] = 'dk'; // Denmark
  map['fi'] = 'fi'; // Finland
  map['pt'] = 'pt'; // Portugal
  map['br'] = 'br'; // Brazil
  map['mx'] = 'mx'; // Mexico
  map['ar'] = 'ar'; // Argentina
  map['cl'] = 'cl'; // Chile
  map['co'] = 'co'; // Colombia
  map['pe'] = 'pe'; // Peru

  // EPG IDs commonly end in country codes rather than language codes.
  for (const localeCode of Object.keys(NUMBER_LOCALES)) {
    const country = localeCode.split('-')[1]?.toLowerCase();
    if (country && !Object.prototype.hasOwnProperty.call(map, country)) {
      map[country] = country;
    }
  }
  map['gb'] = 'uk';

  return map;
})();

export function normalizeNumberAlias(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

const NUMBER_ALIASES_BY_TAG = (() => {
  const aliasesByTag = new Map();
  const globalAliases = new Map();

  const addAlias = (aliases, word, value) => {
    const current = aliases.get(word);
    if (current === undefined) aliases.set(word, value);
    else if (current !== value) aliases.set(word, null);
  };

  for (const localeCode of Object.keys(NUMBER_LOCALES)) {
    const [language, country] = localeCode.toLowerCase().split('-');
    const tags = language === country ? [language] : [language, country];
    const config = new ToNumbers({ localeCode }).getParserConfig();

    for (const source of [config.wordToNumber, config.formalWordToNumber]) {
      if (!source) continue;

      for (const [word, value] of source) {
        // ponytail: Written channel numbers are capped at 20; use validated locale parsing if higher names appear.
        if (!Number.isInteger(value) || value < 0 || value > 20) continue;
        const alias = normalizeNumberAlias(word);
        if (!alias) continue;

        addAlias(globalAliases, alias, value);
        for (const tag of tags) {
          if (!aliasesByTag.has(tag)) aliasesByTag.set(tag, new Map());
          addAlias(aliasesByTag.get(tag), alias, value);
        }
      }
    }
  }

  // Existing EPG data uses .uk while locale data uses en-GB.
  aliasesByTag.set('uk', aliasesByTag.get('gb'));
  aliasesByTag.set('*', new Map([...globalAliases].filter(([word, value]) => {
    return value !== null && [...word.replace(/\s/gu, '')].length >= 3;
  })));

  return aliasesByTag;
})();

export function normalizeWrittenNumberSuffix(value, language) {
  const aliases = NUMBER_ALIASES_BY_TAG.get(language) || NUMBER_ALIASES_BY_TAG.get('*');
  const parts = value
    .normalize('NFKC')
    .replace(/([\p{Script=Latin}\p{N}])(?=(?!\p{Script=Latin})[\p{L}\p{M}])/gu, '$1 ')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);

  for (let index = 0; index < parts.length; index++) {
    const alias = parts.slice(index).join(' ').toLowerCase();
    const number = aliases.get(alias);
    if (number !== undefined && number !== null) {
      return [...parts.slice(0, index), number].join(' ');
    }
  }

  return parts.join(' ');
}

export const ROMAN_NUMERALS = ' i ii iii iv v vi vii viii ix x xi xii xiii xiv xv xvi xvii xviii xix xx'.split(' ');
export const ROMAN_NUMERAL_PATTERN = new RegExp(`(^|[\\s._|:/-]+)(${ROMAN_NUMERALS.slice(1).reverse().join('|')})\\s*$`, 'iu');

export const COMPACT_NUMBER_ALIASES = new Map([
  ['kabeleins', 'kabel1'],
  ['rtlii', 'rtl2'],
  ['rtlzwei', 'rtl2']
]);

// Helper functions for bit signature optimization
export function popcount(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return ((n + (n >>> 4) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

