import ISO6391 from 'iso-639-1';

// Optimization: Pre-compile regex patterns to avoid re-compilation on every match
const CHANNEL_NAME_PATTERNS = [
  // "Arte HD DE", "CNN INT", "Eurosport 1 FR"
  /^(.+?)\s+([A-Z]{2,3})$/i,

  // "Arte (German)", "CNN (EN)", "Eurosport 1 [ENG]"
  // Fixed regex: removed extra backslashes to correctly match parenthesis
  /^(.+?)\s*[\(\[]([^\)\]]+)[\)\]]$/i,

  // "Arte_DE", "CNN-INT", "Eurosport1.FR", "DE| RTL"
  /^(.+?)[\-_\.\|]([A-Z]{2,3})$/i,

  // "DE: Arte", "EN: CNN", "DE| RTL"
  /^([A-Z]{2,3})[\-_\.\|:]\s*(.+)$/i,
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

const LANGUAGE_MAP = (() => {
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
  map['int'] = 'en'; // International = English
  map['uk'] = 'en'; // UK = English
  map['us'] = 'en'; // US = English
  map['usa'] = 'en'; // USA = English
  map['gr'] = 'el'; // GR -> Greek (el)
  map['greece'] = 'el';
  map['greek'] = 'el';

  return map;
})();

// Helper functions for bit signature optimization
function popcount(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return ((n + (n >>> 4) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

export class ChannelMatcher {
  constructor(epgChannels) {
    this.epgChannels = epgChannels;
    this.languageMap = LANGUAGE_MAP;

    // Pre-parse EPG channels to avoid re-parsing on every match
    this.parsedEpgChannels = this.epgChannels.map(c => ({
        channel: c,
        parsed: this.parseChannelName(c.name)
    }));

    // Optimization: Build indexes for O(1) lookups
    this.baseNameIndex = new Map();
    this.numbersIndex = new Map();

    for (const item of this.parsedEpgChannels) {
        // Index by baseName
        const baseKey = item.parsed.baseName;
        if (!this.baseNameIndex.has(baseKey)) {
            this.baseNameIndex.set(baseKey, []);
        }
        this.baseNameIndex.get(baseKey).push(item);

        // Index by numbersString
        const numKey = item.parsed.numbersString;
        if (!this.numbersIndex.has(numKey)) {
            this.numbersIndex.set(numKey, []);
        }
        this.numbersIndex.get(numKey).push(item);
    }
  }

  /**
   * Extrahiert Channel-Name und Sprache aus verschiedenen Formaten
   */
  parseChannelName(channelName) {
    if (!channelName) return { baseName: '', language: null, original: '', bigrams: new Set() };
    const original = channelName.trim();

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
          const baseName = this.normalizeBaseName(name);
          const numbers = this.extractNumbers(baseName);
          const bigrams = this.getBigrams(baseName);
          const sig = this.createSignature(bigrams);
          return {
            baseName: baseName,
            language: this.normalizeLanguage(lang),
            bigramCount: bigrams.size,
            signature: sig,
            signaturePopcount: this.countSignatureBits(sig),
            // Pre-compute sorted numbers string for O(1) matching
            numbersString: [...numbers].sort().join(',')
          };
        }
      }
    }

    // Kein Sprachcode gefunden
    const baseName = this.normalizeBaseName(original);
    const numbers = this.extractNumbers(baseName);
    const bigrams = this.getBigrams(baseName);
    const sig = this.createSignature(bigrams);
    return {
      baseName: baseName,
      language: null,
      bigramCount: bigrams.size,
      signature: sig,
      signaturePopcount: this.countSignatureBits(sig),
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
    const cleaned = lang.toLowerCase().trim();
    return LANGUAGE_MAP[cleaned] || null;
  }

  /**
   * Normalisiert Channel-Basisnamen (ohne Sprache)
   */
  normalizeBaseName(name) {
    return name
      .toLowerCase()
      .replace(/\s+hd|uhd|4k|fhd|hevc|h\.?264|h\.?265/gi, '') // Qualität
      .replace(/\s+plus|\s*\+/gi, ' plus') // "+" normalisieren
      .replace(/[^\w\s]/g, '') // Sonderzeichen (keeps numbers)
      .replace(/\s+/g, ' ') // Multiple Spaces
      .trim();
  }

  /**
   * Matcht IPTV-Channel zu EPG-Einträgen
   */
  match(iptvChannelName) {
    const parsed = this.parseChannelName(iptvChannelName);
    const iptvNumsString = parsed.numbersString;

    // Helper to verify numbers match
    // Optimized: compares pre-computed sorted number strings to avoid repeated regex and sorting in loops
    const checkNumbers = (epgParsed) => {
        return iptvNumsString === epgParsed.numbersString;
    };

    // 1. Suche nach exaktem Match (Name + Sprache)
    if (parsed.language) {
      const exactMatch = this.findExactMatch(parsed, checkNumbers);
      if (exactMatch) {
        return {
          epgChannel: exactMatch.channel,
          confidence: 1.0,
          method: 'exact_with_language',
          parsed: parsed
        };
      }
    }

    // 2. Suche nach Name ohne Sprache (bester Match)
    let candidates = this.findCandidatesByBaseName(parsed.baseName, checkNumbers);

    if (candidates.length === 1) {
      return {
        epgChannel: candidates[0].channel,
        confidence: 0.9,
        method: 'single_candidate',
        parsed: parsed
      };
    }

    if (candidates.length > 1) {
      // 3. Filtere nach Sprache falls vorhanden
      if (parsed.language) {
        const langFiltered = candidates.filter(c => {
          return c.parsed.language === parsed.language;
        });

        if (langFiltered.length === 1) {
          return {
            epgChannel: langFiltered[0].channel,
            confidence: 0.95,
            method: 'language_filter',
            parsed: parsed
          };
        }

        if (langFiltered.length > 1) {
          // 4. String-Similarity auf den gefilterten Kandidaten
          // Optimization: Pass parsed object
          const best = this.findBestSimilarity(parsed, langFiltered);
          return {
            epgChannel: best.channel.channel,
            confidence: best.score * 0.9,
            method: 'similarity_after_language',
            parsed: parsed
          };
        }
      }

      // 5. Fallback: String-Similarity auf allen Kandidaten
      // Optimization: Pass parsed object
      const best = this.findBestSimilarity(parsed, candidates);
      return {
        epgChannel: best.channel.channel,
        confidence: best.score * 0.7,
        method: 'similarity_fallback',
        parsed: parsed
      };
    }

    // 6. Global Fuzzy Fallback (if base name didn't match exactly)
    // Filter all EPG channels by Number Logic First
    // Optimization: Use index instead of filtering all channels O(N) -> O(1)
    const potentialCandidates = this.numbersIndex.get(iptvNumsString) || [];

    // If language is known, prefer that language, but allow others if score is very high
    // Optimization: Pass parsed object and threshold 0.8
    const bestGlobal = this.findBestSimilarity(parsed, potentialCandidates, 0.8);

    if (bestGlobal.score > 0.8) {
        const candLang = bestGlobal.channel.parsed.language;
        if (parsed.language && candLang && parsed.language !== candLang) {
             return {
                 epgChannel: null,
                 confidence: bestGlobal.score * 0.5,
                 method: 'global_fuzzy_lang_mismatch_rejected',
                 parsed: parsed
             }
        }

        return {
            epgChannel: bestGlobal.channel.channel,
            confidence: bestGlobal.score,
            method: 'global_fuzzy',
            parsed: parsed
        };
    }

    return {
      epgChannel: null,
      confidence: 0,
      method: 'no_match',
      parsed: parsed
    };
  }

  extractNumbers(str) {
      const matches = str.match(/\d+/g);
      return matches ? matches : [];
  }

  findExactMatch(parsed, checkNumbers) {
    // Optimization: Use baseNameIndex for O(1) lookup
    const candidates = this.baseNameIndex.get(parsed.baseName);
    if (!candidates) return undefined;

    return candidates.find(epg => {
      return epg.parsed.language === parsed.language &&
             checkNumbers(epg.parsed);
    });
  }

  findCandidatesByBaseName(baseName, checkNumbers) {
    // Optimization: Use baseNameIndex for O(1) lookup
    const candidates = this.baseNameIndex.get(baseName);
    if (!candidates) return [];

    return candidates.filter(epg => checkNumbers(epg.parsed));
  }

  /**
   * Finds best candidate using Dice Coefficient.
   * Optimized to accept pre-parsed object and prune candidates by length.
   * @param {Object|string} parsedSearch - The parsed channel object (containing baseName, bigrams) or search string.
   * @param {Array} candidates - List of candidate channels.
   * @param {number} threshold - Optional minimum score threshold. If > 0, prunes candidates that cannot mathematically reach the threshold.
   */
  findBestSimilarity(parsedSearch, candidates, threshold = 0) {
    if (!candidates || candidates.length === 0) return { channel: null, score: 0 };

    let searchBaseName, searchBigrams, searchSignature, searchPopcount, searchLen;
    if (typeof parsedSearch === 'string') {
        searchBaseName = this.normalizeBaseName(parsedSearch);
        searchBigrams = this.getBigrams(searchBaseName);
        searchSignature = this.createSignature(searchBigrams);
        searchPopcount = this.countSignatureBits(searchSignature);
        searchLen = searchBigrams.size;
    } else {
        searchBaseName = parsedSearch.baseName;
        searchSignature = parsedSearch.signature;
        searchPopcount = parsedSearch.signaturePopcount;
        searchLen = parsedSearch.bigramCount;

        // Lazy load bigrams/signature if missing (should rarely happen for parsed objects)
        if (!searchSignature || searchLen === undefined) {
             searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
             if (!searchSignature) searchSignature = this.createSignature(searchBigrams);
             if (searchLen === undefined) searchLen = searchBigrams.size;
             if (searchPopcount === undefined) searchPopcount = this.countSignatureBits(searchSignature);
        } else if (searchPopcount === undefined) {
             searchPopcount = this.countSignatureBits(searchSignature);
        }
    }

    // Optimization: Prune candidates based on length if threshold is set
    let minLen = 0;
    let maxLen = Infinity;
    if (threshold > 0) {
        const lenA = searchLen;
        // B >= A * T / (2 - T)
        minLen = Math.ceil(lenA * threshold / (2 - threshold));
        // B <= A * (2 - T) / T
        maxLen = Math.floor(lenA * (2 - threshold) / threshold);
    }

    let bestScore = -1;
    let bestCand = null;

    for (const cand of candidates) {
        // Length check optimization
        if (threshold > 0) {
            // Use bigramCount property instead of bigrams.size to save memory
            const lenB = cand.parsed.bigramCount !== undefined ? cand.parsed.bigramCount : (cand.parsed.bigrams ? cand.parsed.bigrams.size : 0);
            if (lenB < minLen || lenB > maxLen) continue;
        }

        let score = 0;
        if (searchBaseName === cand.parsed.baseName) {
            score = 1;
        } else {
            // Always rely on signature comparison as bigrams are not stored for candidates to save memory
            if (searchSignature && cand.parsed.signature) {
                const candPopcount = cand.parsed.signaturePopcount !== undefined ? cand.parsed.signaturePopcount : this.countSignatureBits(cand.parsed.signature);
                score = this.calculateDiceCoefficientSignature(searchSignature, cand.parsed.signature, searchPopcount, candPopcount);
            } else if (cand.parsed.bigrams) {
                // Fallback only if bigrams are available (legacy or test objects)
                if (!searchBigrams) searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
                score = this.calculateDiceCoefficientSets(searchBigrams, cand.parsed.bigrams);
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestCand = cand;
        }
    }

    return {
      channel: bestCand,
      score: bestScore
    };
  }

  /**
   * Calculates Dice Coefficient (Sørensen–Dice index) for string similarity.
   * Legacy method kept for backward compatibility.
   */
  calculateDiceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const bigramsA = this.getBigrams(a);
    const bigramsB = this.getBigrams(b);

    return this.calculateDiceCoefficientSets(bigramsA, bigramsB);
  }

  /**
   * Calculates Dice Coefficient using pre-computed bigram sets.
   */
  calculateDiceCoefficientSets(bigramsA, bigramsB) {
    if (bigramsA.size === 0 && bigramsB.size === 0) return 0; // Both empty -> 0 similarity? Or 1?
    // If both strings were empty, bigrams empty. Empty strings are equal?
    // Original logic: if (a===b) return 1.
    // If we handle empty case outside, here return 0.

    let intersection = 0;
    // Iterate smaller set for performance
    const [smaller, larger] = bigramsA.size < bigramsB.size ? [bigramsA, bigramsB] : [bigramsB, bigramsA];

    for (const bg of smaller) {
        if (larger.has(bg)) {
            intersection++;
        }
    }

    return (2 * intersection) / (bigramsA.size + bigramsB.size);
  }

  getBigrams(str) {
    const bigrams = new Set();
    if (!str || str.length < 2) return bigrams;

    // Optimization: Pack bigrams into 32-bit integers instead of substrings
    // This reduces memory allocation and GC pressure significantly
    let c1 = str.charCodeAt(0);
    for (let i = 0; i < str.length - 1; i++) {
        const c2 = str.charCodeAt(i + 1);
        const val = (c1 << 16) | c2;
        bigrams.add(val);
        c1 = c2;
    }
    return bigrams;
  }

  createSignature(bigrams) {
      // 1024 bits = 32 x 32-bit integers
      const sig = new Uint32Array(32);
      for (const val of bigrams) {
          // Optimized hash for packed integer (matches approx old behavior: 31*c1 + c2)
          let h = (31 * (val >>> 16) + (val & 0xFFFF));
          h = Math.abs(h | 0) % 1024;

          const idx = Math.floor(h / 32);
          const bit = h % 32;
          sig[idx] |= (1 << bit);
      }
      return sig;
  }

  countSignatureBits(sig) {
      let count = 0;
      for (let i = 0; i < 32; i++) {
          count += popcount(sig[i]);
      }
      return count;
  }

  calculateDiceCoefficientSignature(sigA, sigB, popA, popB) {
      if (popA === 0 && popB === 0) return 0;
      let intersection = 0;
      for (let i = 0; i < 32; i++) {
          intersection += popcount(sigA[i] & sigB[i]);
      }
      return (2 * intersection) / (popA + popB);
  }

}
