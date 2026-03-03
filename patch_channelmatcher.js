import fs from 'fs';

const file = 'src/services/channelMatcher.js';
let content = fs.readFileSync(file, 'utf8');

const suggestFunction = `
  /**
   * Returns top N candidate matches for a given channel name.
   */
  suggest(iptvChannelName, limit = 10) {
    const parsed = this.parseChannelName(iptvChannelName);
    const iptvNumsString = parsed.numbersString;

    let allCandidates = [];

    const checkNumbers = (epgItem) => {
        return iptvNumsString === epgItem.numbersString;
    };

    // 1. Check exact matches (with language)
    if (parsed.language) {
      const exactMatch = this.findExactMatch(parsed, checkNumbers);
      if (exactMatch) {
        allCandidates.push({
          epgChannel: exactMatch.channel,
          confidence: 1.0,
          method: 'exact_with_language',
          parsed: parsed
        });
      }
    }

    // 2. Base name candidates
    let candidates = this.findCandidatesByBaseName(parsed.baseName, checkNumbers);

    if (candidates.length > 0) {
      if (parsed.language) {
        const langFiltered = candidates.filter(c => c.language === parsed.language);
        if (langFiltered.length > 0) {
            const scoredLangFiltered = this.scoreAllCandidates(parsed, langFiltered).map(c => ({
              epgChannel: c.channel.channel,
              confidence: c.score * 0.95,
              method: 'language_filter',
              parsed: parsed
            }));
            allCandidates = allCandidates.concat(scoredLangFiltered);
        } else {
            const scoredCandidates = this.scoreAllCandidates(parsed, candidates).map(c => ({
              epgChannel: c.channel.channel,
              confidence: c.score * 0.8,
              method: 'similarity_after_language',
              parsed: parsed
            }));
            allCandidates = allCandidates.concat(scoredCandidates);
        }
      } else {
        const scoredCandidates = this.scoreAllCandidates(parsed, candidates).map(c => ({
          epgChannel: c.channel.channel,
          confidence: c.score * 0.9,
          method: 'similarity_fallback',
          parsed: parsed
        }));
        allCandidates = allCandidates.concat(scoredCandidates);
      }
    }

    // 3. Global Fuzzy Fallback
    const potentialCandidates = this.numbersIndex.get(iptvNumsString) || [];
    const searchPopcount = parsed.signaturePopcount;
    const threshold = 0.4; // Lower threshold to get more suggestions
    const minLen = Math.ceil(searchPopcount * threshold / (2 - threshold));
    const maxLen = Math.floor(searchPopcount * (2 - threshold) / threshold);

    const startIdx = this.findLowerBound(potentialCandidates, minLen);
    const endIdx = this.findUpperBound(potentialCandidates, maxLen);

    if (startIdx < endIdx) {
      const fuzzyCandidates = potentialCandidates.slice(startIdx, endIdx);
      const scoredGlobal = this.scoreAllCandidates(parsed, fuzzyCandidates, threshold, true);

      for (const bestGlobal of scoredGlobal) {
        if (bestGlobal.score > 0.4) {
          const representative = bestGlobal.channel;
          const variants = this.baseNameIndex.get(representative.baseName) || [representative];

          let validVariants = variants;
          if (variants.length > 1) {
            validVariants = variants.filter(v => v.numbersString === representative.numbersString);
          }

          for (const variant of validVariants) {
             let confidence = bestGlobal.score * 0.8;
             if (parsed.language && variant.language && variant.language !== parsed.language) {
                 confidence *= 0.5;
             } else if (parsed.language && variant.language === parsed.language) {
                 confidence *= 1.1; // Boost matching language
             }
             allCandidates.push({
               epgChannel: variant.channel,
               confidence: Math.min(confidence, 1.0),
               method: 'global_fuzzy',
               parsed: parsed
             });
          }
        }
      }
    }

    // Deduplicate by epgChannel.id
    const seen = new Set();
    const uniqueCandidates = [];

    // Sort all candidates by confidence descending
    allCandidates.sort((a, b) => b.confidence - a.confidence);

    for (const cand of allCandidates) {
      if (!seen.has(cand.epgChannel.id)) {
        seen.add(cand.epgChannel.id);
        uniqueCandidates.push(cand);
        if (uniqueCandidates.length >= limit) break;
      }
    }

    return uniqueCandidates;
  }

  /**
   * Scores all candidates instead of just finding the best one.
   */
  scoreAllCandidates(parsedSearch, candidates, threshold = 0, isSorted = false) {
    if (!candidates || candidates.length === 0) return [];

    let searchBaseName, searchBigrams, searchSignature, searchPopcount, searchLen, searchNonZeroIndices;
    if (typeof parsedSearch === 'string') {
        searchBaseName = this.normalizeBaseName(parsedSearch);
        searchSignature = this.createSignatureFromBaseName(searchBaseName);
        searchPopcount = this.countSignatureBits(searchSignature);
        searchNonZeroIndices = this.getNonZeroIndices(searchSignature);
        searchLen = searchPopcount;
    } else {
        searchBaseName = parsedSearch.baseName;
        searchSignature = parsedSearch.signature;
        searchPopcount = parsedSearch.signaturePopcount;
        searchNonZeroIndices = parsedSearch.nonZeroIndices;
        searchLen = parsedSearch.bigramCount;

        if (!searchSignature || searchLen === undefined) {
             searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
             if (!searchSignature) searchSignature = this.createSignature(searchBigrams);
             if (searchLen === undefined) searchLen = searchBigrams.size;
             if (searchPopcount === undefined) searchPopcount = this.countSignatureBits(searchSignature);
             if (!searchNonZeroIndices) searchNonZeroIndices = this.getNonZeroIndices(searchSignature);
        } else if (searchPopcount === undefined) {
             searchPopcount = this.countSignatureBits(searchSignature);
        }
    }

    let minLen = 0;
    let maxLen = Infinity;

    if (threshold > 0) {
        minLen = Math.ceil(searchLen * threshold / (2 - threshold));
        maxLen = Math.floor(searchLen * (2 - threshold) / threshold);
    }

    const scored = [];

    for (const cand of candidates) {
        const lenB = cand.signaturePopcount !== undefined ? cand.signaturePopcount : (cand.bigrams ? cand.bigrams.size : 0);

        if (lenB < minLen) continue;
        if (lenB > maxLen) {
            if (isSorted) break;
            continue;
        }

        let score = 0;
        if (searchBaseName === cand.baseName) {
            score = 1;
        } else {
            if (searchSignature && cand.signature) {
                const candPopcount = cand.signaturePopcount !== undefined ? cand.signaturePopcount : this.countSignatureBits(cand.signature);
                const searchIndicesCount = searchNonZeroIndices ? searchNonZeroIndices.length : 32;
                const candIndicesCount = cand.nonZeroIndices ? cand.nonZeroIndices.length : 32;

                if (searchIndicesCount < candIndicesCount) {
                     if (searchIndicesCount < 16) {
                          score = this.calculateDiceCoefficientSignatureSparse(searchSignature, cand.signature, searchPopcount, candPopcount, searchNonZeroIndices);
                     } else {
                          score = this.calculateDiceCoefficientSignature(searchSignature, cand.signature, searchPopcount, candPopcount);
                     }
                } else {
                     if (candIndicesCount < 16) {
                          score = this.calculateDiceCoefficientSignatureSparse(searchSignature, cand.signature, searchPopcount, candPopcount, cand.nonZeroIndices);
                     } else {
                          score = this.calculateDiceCoefficientSignature(searchSignature, cand.signature, searchPopcount, candPopcount);
                     }
                }
            } else if (cand.bigrams) {
                if (!searchBigrams) searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
                score = this.calculateDiceCoefficientSets(searchBigrams, cand.bigrams);
            }
        }

        if (score > threshold) {
            scored.push({ channel: cand, score });
        }
    }

    return scored.sort((a, b) => b.score - a.score);
}
`;

// Only replace the FIRST occurrence of a stable anchor point.
// We'll place the new methods just before findLowerBound.
const targetLine = '  findLowerBound(list, value) {';
let targetIndex = content.indexOf(targetLine);
if (targetIndex !== -1) {
    content = content.substring(0, targetIndex) + suggestFunction + '\n\n' + content.substring(targetIndex);
    fs.writeFileSync(file, content);
} else {
    console.error("Target line not found");
}
