import ISO6391 from 'iso-639-1';

export class ChannelMatcher {
  constructor(epgChannels) {
    this.epgChannels = epgChannels;
    this.languageMap = this.buildLanguageMap();
    // Pre-parse EPG channels to avoid re-parsing on every match
    this.parsedEpgChannels = this.epgChannels.map(c => ({
        channel: c,
        parsed: this.parseChannelName(c.name)
    }));
  }

  /**
   * Erstellt Mapping aller möglichen Sprachkürzel-Varianten
   */
  buildLanguageMap() {
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
      const code2 = this.getISO6392Code(code);
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
  }

  /**
   * Extrahiert Channel-Name und Sprache aus verschiedenen Formaten
   */
  parseChannelName(channelName) {
    if (!channelName) return { baseName: '', language: null, original: '' };
    const original = channelName.trim();

    // Pattern-Matching für verschiedene Formate
    const patterns = [
      // "Arte HD DE", "CNN INT", "Eurosport 1 FR"
      /^(.+?)\s+([A-Z]{2,3})$/i,

      // "Arte (German)", "CNN (EN)", "Eurosport 1 [ENG]"
      /^(.+?)\s*[\\(\\[]([^\\)\\]]+)[\)\]]$/i,

      // "Arte_DE", "CNN-INT", "Eurosport1.FR", "DE| RTL"
      /^(.+?)[\-_\.\|]([A-Z]{2,3})$/i,

      // "DE: Arte", "EN: CNN", "DE| RTL"
      /^([A-Z]{2,3})[\-_\.\|:]\s*(.+)$/i,
    ];

    for (const pattern of patterns) {
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
          return {
            baseName: this.normalizeBaseName(name),
            language: this.normalizeLanguage(lang),
            original: original
          };
        }
      }
    }

    // Kein Sprachcode gefunden
    return {
      baseName: this.normalizeBaseName(original),
      language: null,
      original: original
    };
  }

  /**
   * Prüft ob String ein Sprachcode sein könnte
   */
  isLanguageCode(str) {
    if (!str) return false;
    const cleaned = str.toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(this.languageMap, cleaned);
  }

  /**
   * Normalisiert Sprachcode zu ISO 639-1 (2-Buchstaben)
   */
  normalizeLanguage(lang) {
    const cleaned = lang.toLowerCase().trim();
    return this.languageMap[cleaned] || null;
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
    const iptvNums = this.extractNumbers(parsed.baseName);

    // Helper to verify numbers match
    const checkNumbers = (epgBaseName) => {
        const epgNums = this.extractNumbers(epgBaseName);
        if (iptvNums.length === 0 && epgNums.length === 0) return true;
        if (iptvNums.length !== epgNums.length) return false;
        // Strict set equality
        const s1 = [...iptvNums].sort().join(',');
        const s2 = [...epgNums].sort().join(',');
        return s1 === s2;
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
          const best = this.findBestSimilarity(iptvChannelName, langFiltered);
          return {
            epgChannel: best.channel.channel,
            confidence: best.score * 0.9,
            method: 'similarity_after_language',
            parsed: parsed
          };
        }
      }

      // 5. Fallback: String-Similarity auf allen Kandidaten
      const best = this.findBestSimilarity(iptvChannelName, candidates);
      return {
        epgChannel: best.channel.channel,
        confidence: best.score * 0.7,
        method: 'similarity_fallback',
        parsed: parsed
      };
    }

    // 6. Global Fuzzy Fallback (if base name didn't match exactly)
    // Filter all EPG channels by Number Logic First
    const potentialCandidates = this.parsedEpgChannels.filter(c => checkNumbers(c.parsed.baseName));

    // If language is known, prefer that language, but allow others if score is very high
    const bestGlobal = this.findBestSimilarity(parsed.baseName, potentialCandidates);

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
    return this.parsedEpgChannels.find(epg => {
      return epg.parsed.baseName === parsed.baseName &&
             epg.parsed.language === parsed.language &&
             checkNumbers(epg.parsed.baseName);
    });
  }

  findCandidatesByBaseName(baseName, checkNumbers) {
    return this.parsedEpgChannels.filter(epg => {
      return epg.parsed.baseName === baseName && checkNumbers(epg.parsed.baseName);
    });
  }

  findBestSimilarity(searchName, candidates) {
    if (!candidates || candidates.length === 0) return { channel: null, score: 0 };

    const normalized = this.normalizeBaseName(searchName);

    let bestScore = -1;
    let bestCand = null;

    for (const cand of candidates) {
        const score = this.calculateDiceCoefficient(normalized, cand.parsed.baseName);
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
   * Range 0.0 to 1.0.
   */
  calculateDiceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const bigramsA = this.getBigrams(a);
    const bigramsB = this.getBigrams(b);

    if (bigramsA.size === 0 && bigramsB.size === 0) return 0;

    let intersection = 0;
    for (const bg of bigramsA) {
        if (bigramsB.has(bg)) {
            intersection++;
        }
    }

    return (2 * intersection) / (bigramsA.size + bigramsB.size);
  }

  getBigrams(str) {
    const bigrams = new Set();
    for (let i = 0; i < str.length - 1; i++) {
        bigrams.add(str.substring(i, i + 2));
    }
    return bigrams;
  }

  getISO6392Code(iso6391Code) {
    // Mapping für häufige Codes
    const mapping = {
      'de': 'deu', 'en': 'eng', 'fr': 'fra', 'es': 'spa',
      'it': 'ita', 'pt': 'por', 'nl': 'nld', 'pl': 'pol',
      'tr': 'tur', 'ar': 'ara', 'ru': 'rus', 'zh': 'zho',
      'ja': 'jpn', 'ko': 'kor', 'el': 'gre' // el=Greek
    };
    return mapping[iso6391Code];
  }
}
