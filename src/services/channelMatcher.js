import { ChannelMatcherScoring } from './channelMatcherScoring.js';

export class ChannelMatcher extends ChannelMatcherScoring {
  /**
   * Matcht IPTV-Channel zu EPG-Einträgen
   */
  match(iptvChannelName, providedEpgId = null) {
    // 0. Wenn eine tvg-id aus der Playlist vorliegt, versuche einen exakten Match auf diese ID
    if (providedEpgId) {
      const lowerEpgId = providedEpgId.toLowerCase();
      const exactEpgIdMatch = this.epgIdIndex.get(lowerEpgId);
      if (exactEpgIdMatch) {
        return {
          epgChannel: exactEpgIdMatch,
          confidence: 1.0,
          method: 'exact_tvg_id',
          parsed: this.parseChannelName(iptvChannelName, providedEpgId)
        };
      }
    }

    const parsed = this.parseChannelName(iptvChannelName, providedEpgId);

    const iptvNumsString = parsed.numbersString;

    // Helper to verify numbers match
    // Optimized: compares pre-computed sorted number strings to avoid repeated regex and sorting in loops
    const checkNumbers = (epgItem) => {
        return iptvNumsString === epgItem.numbersString;
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
      const singleCand = candidates[0];

      // If we requested a language, but the single candidate has a different explicit language, don't blindly accept it.
      // E.g. search "DE| DISNEY" (de) matches only "DISNEY.gr" (el).
      const hasLanguageMismatch = parsed.language && singleCand.language && singleCand.language !== parsed.language;

      if (!hasLanguageMismatch) {
        return {
          epgChannel: singleCand.channel,
          confidence: 0.9,
          method: 'single_candidate',
          parsed: parsed
        };
      }
      // If there's a mismatch, we let it fall through to the fallback logic where it will be heavily penalized.
    }

    if (candidates.length >= 1) { // Changed to >= 1 to handle the single mismatched candidate falling through
      // 3. Filtere nach Sprache falls vorhanden
      if (parsed.language) {
        const langFiltered = candidates.filter(c => {
          return c.language === parsed.language;
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

      // Penalty logic for fallback if we requested a specific language
      if (parsed.language && best.channel && best.channel.language && best.channel.language !== parsed.language) {
          // Explicitly different language -> heavily penalize
          best.score *= 0.1;
      } else if (parsed.language && best.channel && !best.channel.language) {
          // No explicit language, slight penalty
          best.score *= 0.9;
      }

      const similarityConfidence = best.score * 0.7;

      // Store the best similarity fallback to return if global fuzzy search doesn't find anything better
      const bestSimilarityFallback = {
        epgChannel: best.channel ? best.channel.channel : null,
        confidence: similarityConfidence,
        method: 'similarity_fallback',
        parsed: parsed
      };

      // If the best candidate from the base name fallback has very low confidence (e.g. because of language penalty)
      // We should fall through to the global fuzzy search instead of immediately returning a bad match.
      if (similarityConfidence > 0.4) {
          // Wait! Let's double check if we really want to return this.
          // If we heavily penalized it, the score will be very low (e.g., 1.0 * 0.1 * 0.7 = 0.07).
          // But what if it was initially very high and we didn't penalize it enough?
          // If explicitly different language, we shouldn't return it as a good match unless we have to.
          // With best.score *= 0.1, similarityConfidence is at most 0.07, so it will fall through anyway.
          return bestSimilarityFallback;
      }

      // If confidence is low, we store it and let it fall through to global fuzzy,
      // but if global fuzzy fails, we should still return the best match we found (or no match if it's really bad)
      // We'll handle this by letting it fall through.
    }

    // 6. Global Fuzzy Fallback (if base name didn't match exactly, or if the match was heavily penalized)
    // Filter all EPG channels by Number Logic First
    // Optimization: Use index instead of filtering all channels O(N) -> O(1)
    const potentialCandidates = this.numbersIndex.get(iptvNumsString) || [];

    // Optimization: Prune using binary search on signaturePopcount
    // B >= A * T / (2 - T)
    // B <= A * (2 - T) / T
    const searchPopcount = parsed.signaturePopcount;
    const threshold = 0.8;
    const minLen = Math.ceil(searchPopcount * threshold / (2 - threshold));
    const maxLen = Math.floor(searchPopcount * (2 - threshold) / threshold);

    const startIdx = this.findLowerBound(potentialCandidates, minLen);
    const endIdx = this.findUpperBound(potentialCandidates, maxLen);

    // If range is empty or invalid, skip
    if (startIdx >= endIdx) {
        return {
            epgChannel: null,
            confidence: 0,
            method: 'no_match',
            parsed: parsed
        };
    }

    const fuzzyCandidates = potentialCandidates.slice(startIdx, endIdx);

    // If language is known, prefer that language, but allow others if score is very high
    // Optimization: Pass parsed object and threshold 0.8, and indicate candidates are sorted by length
    const bestGlobal = this.findBestSimilarity(parsed, fuzzyCandidates, 0.8, true);

    if (bestGlobal.score > 0.8) {
        // Expand the representative back to all variants
        const representative = bestGlobal.channel;
        let finalCandidate = representative;

        // Find all variants with this base name
        const variants = this.baseNameIndex.get(representative.baseName);

        if (variants && variants.length > 1) {
            // Filter variants that match the number group of the representative
            // (baseNameIndex ignores numbers, so we need to ensure we don't pick a variant with different numbers)
            const numberGroupVariants = variants.filter(v => v.numbersString === representative.numbersString);

            if (numberGroupVariants.length > 0) {
                 if (parsed.language) {
                      // Try to find a variant matching the requested language
                      const langMatch = numberGroupVariants.find(v => v.language === parsed.language);
                      if (langMatch) {
                           finalCandidate = langMatch;
                      } else {
                           // If language requested but no variant matches, stick with representative
                           // We check later if we should reject due to mismatch
                           finalCandidate = numberGroupVariants.find(v => !v.language) || finalCandidate;
                      }
                 }
                 // If no language requested, representative is fine
            }
        }

        let finalConfidence = bestGlobal.score;
        if (parsed.language && finalCandidate.language && finalCandidate.language !== parsed.language) {
             finalConfidence *= 0.1; // heavily penalize mismatched language
        } else if (parsed.language && !finalCandidate.language) {
             finalConfidence *= 0.9; // slight penalty for no explicit language
        }

        // Even in global fuzzy search, if the match is decent, allow it to return
        // but if we penalized it heavily, it won't pass this check
        if (finalConfidence > 0.4) {
            return {
                epgChannel: finalCandidate.channel,
                confidence: finalConfidence,
                method: 'global_fuzzy',
                parsed: parsed
            };
        }
    }

    // If we made it here, global fuzzy didn't find a good match either.
    // If we have a fallback match from earlier, we should use it if it's better than nothing.
    // However, if we're here, bestSimilarityFallback (if it exists) had confidence <= 0.4.
    // It's usually better to just return no_match.
    return {
      epgChannel: null,
      confidence: 0,
      method: 'no_match',
      parsed: parsed
    };
  }


  /**
   * Returns top N candidate matches for a given channel name.
   */
  suggest(iptvChannelName, providedEpgId = null, limit = 10) {
    const parsed = this.parseChannelName(iptvChannelName, providedEpgId);
    const iptvNumsString = parsed.numbersString;

    let allCandidates = [];

    const checkNumbers = (epgItem) => {
        return iptvNumsString === epgItem.numbersString;
    };

    // 0. Wenn eine tvg-id aus der Playlist vorliegt, versuche einen exakten Match auf diese ID
    if (providedEpgId) {
      const lowerEpgId = providedEpgId.toLowerCase();
      const exactEpgIdMatch = this.epgIdIndex.get(lowerEpgId);
      if (exactEpgIdMatch) {
        allCandidates.push({
          epgChannel: exactEpgIdMatch,
          confidence: 1.0,
          method: 'exact_tvg_id',
          parsed: parsed
        });
      }
    }

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
            const scoredCandidates = this.scoreAllCandidates(parsed, candidates).map(c => {
               let conf = c.score * 0.8;
               if (c.channel.language && c.channel.language !== parsed.language) {
                   conf *= 0.1; // penalize explicit language mismatch
               } else if (!c.channel.language) {
                   conf *= 0.9; // slight penalty for no language
               }
               return {
                 epgChannel: c.channel.channel,
                 confidence: conf,
                 method: 'similarity_after_language',
                 parsed: parsed
               };
            });
            allCandidates = allCandidates.concat(scoredCandidates);
        }
      } else {
        const scoredCandidates = this.scoreAllCandidates(parsed, candidates).map(c => {
           let conf = c.score * 0.9;
           if (parsed.language && c.channel.language && c.channel.language !== parsed.language) {
               conf *= 0.1;
           } else if (parsed.language && !c.channel.language) {
               conf *= 0.9;
           }
           return {
             epgChannel: c.channel.channel,
             confidence: conf,
             method: 'similarity_fallback',
             parsed: parsed
           };
        });
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
                 confidence *= 0.1; // heavily penalize mismatched language
             } else if (parsed.language && !variant.language) {
                 confidence *= 0.9; // slight penalty for no explicit language
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


}
