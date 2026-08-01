import {
  CHANNEL_NAME_PATTERNS,
  LANGUAGE_MAP,
  normalizeWrittenNumberSuffix,
  ROMAN_NUMERALS,
  ROMAN_NUMERAL_PATTERN,
  COMPACT_NUMBER_ALIASES
} from './channelMatcherData.js';

export class ChannelMatcherBase {
  constructor(epgChannels) {
    this.epgChannels = epgChannels;
    this.languageMap = LANGUAGE_MAP;

    // Pre-parse EPG channels to avoid re-parsing on every match
    this.parsedEpgChannels = this.epgChannels.map(c => {
        const parsed = this.parseChannelName(c.name, c.id);
        return {
            channel: c,
            ...parsed
        };
    });

    // Optimization: Build indexes for O(1) lookups
    this.baseNameIndex = new Map();
    this.numbersIndex = new Map();

    // Optimization: O(1) lookup for explicit tvg-id matches
    this.epgIdIndex = new Map();
    for (const c of this.epgChannels) {
        if (c.id) {
            this.epgIdIndex.set(c.id.toLowerCase(), c);
        }
    }

    // Intermediate storage for deduplication: Map<numbersString, Map<baseName, ParsedChannel>>
    // This dramatically reduces the number of candidates for fuzzy matching by grouping variations (HD, SD, etc.)
    const uniqueCandidates = new Map();

    for (const item of this.parsedEpgChannels) {
        // Index by baseName
        const baseKey = item.baseName;
        if (!this.baseNameIndex.has(baseKey)) {
            this.baseNameIndex.set(baseKey, []);
        }
        this.baseNameIndex.get(baseKey).push(item);

        // Group by numbersString -> baseName
        const numKey = item.numbersString;
        if (!uniqueCandidates.has(numKey)) {
            uniqueCandidates.set(numKey, new Map());
        }
        // Only store one representative per baseName
        if (!uniqueCandidates.get(numKey).has(item.baseName)) {
            uniqueCandidates.get(numKey).set(item.baseName, item);
        }
    }

    // Build final numbersIndex from unique candidates
    for (const [numKey, baseMap] of uniqueCandidates) {
        const list = Array.from(baseMap.values());
        // Sort by signaturePopcount for binary search pruning
        list.sort((a, b) => a.signaturePopcount - b.signaturePopcount);
        this.numbersIndex.set(numKey, list);
    }
  }

  /**
   * Extrahiert Channel-Name und Sprache aus verschiedenen Formaten
   */
  parseChannelName(channelName, epgId = null) {
    if (!channelName) return {
        baseName: '',
        language: null,
        signature: new Uint32Array(32),
        signaturePopcount: 0,
        numbersString: ''
    };
    const original = channelName.trim();

    // Versuche, die Sprache aus der EPG ID zu extrahieren (z.B. Boomerang.gr -> gr)
    let idLang = null;
    if (epgId) {
       const parts = epgId.split('.');
       if (parts.length > 1) {
           const suffix = parts[parts.length - 1];
           if (this.isLanguageCode(suffix)) {
               idLang = suffix;
           }
       }
    }

    for (const pattern of CHANNEL_NAME_PATTERNS) {
      const match = original.match(pattern);
      if (match) {
        let name, lang;

        // Prüfe ob Gruppe 1 oder 2 die Sprache ist
        if (this.isLanguageCode(match[2])) {
          name = match[1];
          lang = match[2];
        } else if (this.isLanguageCode(match[1])) {
          name = match[2];
          lang = match[1];
        }

        if (name && lang) {
          const language = this.normalizeLanguage(lang) || this.normalizeLanguage(idLang);
          const baseName = this.normalizeBaseName(name, language);
          const numbers = this.extractNumbers(baseName);
    // Optimization: Skip intermediate Set creation for bigrams
    // Use signature popcount as proxy for bigram count (consistent with scoring)
    const sig = this.createSignatureFromBaseName(baseName);
    const popcount = this.countSignatureBits(sig);
    const nonZeroIndices = this.getNonZeroIndices(sig);

          return {
            baseName: baseName,
            language: language,
            signature: sig,
            signaturePopcount: popcount,
            // Use popcount as proxy for bigramCount to avoid Set allocation in findBestSimilarity
            bigramCount: popcount,
            nonZeroIndices: nonZeroIndices,
            // Pre-compute sorted numbers string for O(1) matching
            numbersString: [...numbers].sort().join(',')
          };
        }
      }
    }

    // Kein Sprachcode gefunden
    const language = this.normalizeLanguage(idLang);
    const baseName = this.normalizeBaseName(original, language);
    const numbers = this.extractNumbers(baseName);

    // Optimization: Skip intermediate Set creation
    const sig = this.createSignatureFromBaseName(baseName);
    const popcount = this.countSignatureBits(sig);
    const nonZeroIndices = this.getNonZeroIndices(sig);

    return {
      baseName: baseName,
      language: language,
      signature: sig,
      signaturePopcount: popcount,
      bigramCount: popcount,
      nonZeroIndices: nonZeroIndices,
      // Pre-compute sorted numbers string for O(1) matching
      numbersString: [...numbers].sort().join(',')
    };
  }

  /**
   * Prüft ob String ein Sprachcode sein könnte
   */
  isLanguageCode(str) {
    if (!str) return false;
    const cleaned = str.toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, cleaned);
  }

  /**
   * Normalisiert Sprachcode zu ISO 639-1 (2-Buchstaben)
   */
  normalizeLanguage(lang) {
    if (!lang) return null;
    const cleaned = lang.toLowerCase().trim();
    return LANGUAGE_MAP[cleaned] || null;
  }

  /**
   * Normalisiert Channel-Basisnamen (ohne Sprache)
   */
  normalizeBaseName(name, language = null) {
    let base = name
      .toLowerCase()
      .replace(/\b(?:hd|fhd|uhd|qhd|sd|fd|2k|4k|8k|1080p|720p|hevc|hq|lq|h\.?264|h\.?265|m3u8|50fps|60fps|unknown|unk|slow|dead|backup|rec)\b/gi, '') // Qualität / Status / Rec
      .replace(/\b(?:magenta|myteam|myteamtv)\s*sport\b/gi, 'myteamtv') // Magenta Sport / MyTeam Sport -> MyTeamTV mapping
      .replace(/\bsport\s*(\d*)\s*(?:-|\|)?\s*myteamtv\b/gi, 'myteamtv $1') // "Sport 1 - myTeamTV" -> "myteamtv 1"
      .replace(/\braw\b/gi, '') // "RAW" entfernen
      .replace(/\s+plus|\s*\+/gi, ' plus') // "+" normalisieren
      .replace(/\b(?:ucl|uel|uecl|cl|el|pl|f1|spfl|spl)\b/gi, '') // Sport Events/Ligen
      .trim();

    base = normalizeWrittenNumberSuffix(base, language);

    base = base
      .replace(ROMAN_NUMERAL_PATTERN, (match, separator, numeral) => {
        return `${separator}${ROMAN_NUMERALS.indexOf(numeral.toLowerCase())}`;
      })
      .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, '') // Sonderzeichen entfernen, Unicode-Namen erhalten
      .replace(/^the\s+/gi, '') // Startwort "The" entfernen ("The History Channel" -> "history channel")
      .replace(/\s+(?:network|channel|tv)\s*$/gi, '') // Typische Suffixe entfernen
      .trim();

    // Strip leading zeros from numbers
    base = base.replace(/\b0+(\d+)\b/g, '$1');

    // Remove all spaces AFTER stripping leading zeros, otherwise \b word boundary won't work correctly for zeros
    base = base.replace(/\s+/g, '');

    return COMPACT_NUMBER_ALIASES.get(base) || base;
  }


}
