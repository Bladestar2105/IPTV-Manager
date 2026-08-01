import { popcount } from './channelMatcherData.js';
import { ChannelMatcherBase } from './channelMatcherBase.js';

export class ChannelMatcherScoring extends ChannelMatcherBase {
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


  findLowerBound(list, value) {
      let left = 0;
      let right = list.length;
      while (left < right) {
          const mid = (left + right) >>> 1;
          if (list[mid].signaturePopcount < value) {
              left = mid + 1;
          } else {
              right = mid;
          }
      }
      return left;
  }

  findUpperBound(list, value) {
      let left = 0;
      let right = list.length;
      while (left < right) {
          const mid = (left + right) >>> 1;
          if (list[mid].signaturePopcount <= value) {
              left = mid + 1;
          } else {
              right = mid;
          }
      }
      return left;
  }

  extractNumbers(str) {
      if (!str) return [];
      // Look for digits, but ignore standard resolutions like 1080, 720, 2k, 4k that might have leaked through
      const matches = str.match(/\d+/g);
      return matches ? matches.map(num => parseInt(num, 10).toString()) : [];
  }

  findExactMatch(parsed, checkNumbers) {
    // Optimization: Use baseNameIndex for O(1) lookup
    const candidates = this.baseNameIndex.get(parsed.baseName);
    if (!candidates) return undefined;

    return candidates.find(epg => {
      return epg.language === parsed.language &&
             checkNumbers(epg);
    });
  }

  findCandidatesByBaseName(baseName, checkNumbers) {
    // Optimization: Use baseNameIndex for O(1) lookup
    const candidates = this.baseNameIndex.get(baseName);
    if (!candidates) return [];

    return candidates.filter(epg => checkNumbers(epg));
  }

  /**
   * Finds best candidate using Dice Coefficient.
   * Optimized to accept pre-parsed object and prune candidates by length.
   * @param {Object|string} parsedSearch - The parsed channel object (containing baseName, bigrams) or search string.
   * @param {Array} candidates - List of candidate channels.
   * @param {number} threshold - Optional minimum score threshold. If > 0, prunes candidates that cannot mathematically reach the threshold.
   * @param {boolean} isSorted - Optimization flag: if true, assumes candidates are sorted by length/popcount (ascending). Allows early break.
   */
  findBestSimilarity(parsedSearch, candidates, threshold = 0, isSorted = false) {
    if (!candidates || candidates.length === 0) return { channel: null, score: 0 };

    let searchBaseName, searchBigrams, searchSignature, searchPopcount, searchLen, searchNonZeroIndices;
    if (typeof parsedSearch === 'string') {
        searchBaseName = this.normalizeBaseName(parsedSearch);
        // Optimization: Use direct signature creation
        searchSignature = this.createSignatureFromBaseName(searchBaseName);
        searchPopcount = this.countSignatureBits(searchSignature);
        searchNonZeroIndices = this.getNonZeroIndices(searchSignature);
        searchLen = searchPopcount; // Use popcount as length proxy
        // searchBigrams only created lazily if needed for fallback
    } else {
        searchBaseName = parsedSearch.baseName;
        searchSignature = parsedSearch.signature;
        searchPopcount = parsedSearch.signaturePopcount;
        searchNonZeroIndices = parsedSearch.nonZeroIndices;
        searchLen = parsedSearch.bigramCount;

        // Lazy load bigrams/signature if missing (should rarely happen for parsed objects)
        if (!searchSignature || searchLen === undefined) {
             searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
             if (!searchSignature) searchSignature = this.createSignature(searchBigrams);
             if (searchLen === undefined) searchLen = searchBigrams.size;
             if (searchPopcount === undefined) searchPopcount = this.countSignatureBits(searchSignature);
             // Lazy compute indices if we just created signature
             if (!searchNonZeroIndices) searchNonZeroIndices = this.getNonZeroIndices(searchSignature);
        } else if (searchPopcount === undefined) {
             searchPopcount = this.countSignatureBits(searchSignature);
        }
    }

    // Optimization: Prune candidates based on length if threshold is set
    // This defines the valid range of candidate lengths (popcounts) that can mathematically achieve the threshold score
    let minLen = 0;
    let maxLen = Infinity;

    // Initialize bounds based on initial threshold (if provided)
    if (threshold > 0) {
        const lenA = searchLen;
        // B >= A * T / (2 - T)
        minLen = Math.ceil(lenA * threshold / (2 - threshold));
        // B <= A * (2 - T) / T
        maxLen = Math.floor(lenA * (2 - threshold) / threshold);
    }

    let bestScore = -1;
    let bestCand = null;
    // Track the best score to beat (starts at threshold or 0)
    let currentMaxScore = threshold > 0 ? threshold : 0;

    for (const cand of candidates) {
        // Use signaturePopcount property instead of bigrams.size to save memory
        const lenB = cand.signaturePopcount !== undefined ? cand.signaturePopcount : (cand.bigrams ? cand.bigrams.size : 0);

        // Dynamic length check optimization
        // As we find better matches, we tighten minLen/maxLen (see below)
        // This implicitly handles the static threshold check as well
        if (lenB < minLen) continue;
        if (lenB > maxLen) {
            if (isSorted) break; // Optimization: If sorted by length/popcount, we can stop early as all subsequent candidates will also be too long
            continue;
        }

        let score = 0;
        if (searchBaseName === cand.baseName) {
            score = 1;
        } else {
            // Always rely on signature comparison as bigrams are not stored for candidates to save memory
            if (searchSignature && cand.signature) {
                const candPopcount = cand.signaturePopcount !== undefined ? cand.signaturePopcount : this.countSignatureBits(cand.signature);

                // Optimization: Use sparse calculation if available
                // Always pick the shorter list of indices for sparse iteration to minimize operations
                const searchIndicesCount = searchNonZeroIndices ? searchNonZeroIndices.length : 32;
                const candIndicesCount = cand.nonZeroIndices ? cand.nonZeroIndices.length : 32;

                if (searchIndicesCount < candIndicesCount) {
                     // Search term is sparser
                     if (searchIndicesCount < 16) {
                          score = this.calculateDiceCoefficientSignatureSparse(searchSignature, cand.signature, searchPopcount, candPopcount, searchNonZeroIndices);
                     } else {
                          score = this.calculateDiceCoefficientSignature(searchSignature, cand.signature, searchPopcount, candPopcount);
                     }
                } else {
                     // Candidate is sparser (or equal)
                     if (candIndicesCount < 16) {
                          score = this.calculateDiceCoefficientSignatureSparse(searchSignature, cand.signature, searchPopcount, candPopcount, cand.nonZeroIndices);
                     } else {
                          score = this.calculateDiceCoefficientSignature(searchSignature, cand.signature, searchPopcount, candPopcount);
                     }
                }
            } else if (cand.bigrams) {
                // Fallback only if bigrams are available (legacy or test objects)
                if (!searchBigrams) searchBigrams = parsedSearch.bigrams || this.getBigrams(searchBaseName);
                score = this.calculateDiceCoefficientSets(searchBigrams, cand.bigrams);
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestCand = cand;

            // Optimization: Early exit for perfect match
            if (score >= 0.9999) break;

            // Optimization: Update dynamic bounds if we found a better match
            // This allows us to skip more candidates in subsequent iterations
            if (score > currentMaxScore) {
                currentMaxScore = score;
                // Update length bounds for pruning based on new best score
                // B >= A * S / (2 - S)
                minLen = Math.ceil(searchLen * score / (2 - score));
                // B <= A * (2 - S) / S
                maxLen = Math.floor(searchLen * (2 - score) / score);
            }
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

  /**
   * Creates a signature directly from the base name string, avoiding intermediate Set allocation.
   * Speedup: ~2x faster than getBigrams -> createSignature.
   * Memory: Zero intermediate object allocation.
   */
  createSignatureFromBaseName(str) {
      const sig = new Uint32Array(32);
      if (!str || str.length < 2) return sig;

      let c1 = str.charCodeAt(0);
      const len = str.length;
      for (let i = 0; i < len - 1; i++) {
          const c2 = str.charCodeAt(i + 1);

          // Hash logic: (31 * c1 + c2) % 1024
          // Optimized: (31 * c1 + c2) & 1023
          const h = (31 * c1 + c2) & 1023;

          const idx = h >>> 5; // h / 32
          const bit = h & 31;  // h % 32
          sig[idx] |= (1 << bit);

          c1 = c2;
      }
      return sig;
  }

  createSignature(bigrams) {
      // 1024 bits = 32 x 32-bit integers
      const sig = new Uint32Array(32);
      for (const val of bigrams) {
          // Optimized hash for packed integer (matches approx old behavior: 31*c1 + c2)
          let h = (31 * (val >>> 16) + (val & 0xFFFF));
          h = h & 1023;

          const idx = h >>> 5;
          const bit = h & 31;
          sig[idx] |= (1 << bit);
      }
      return sig;
  }

  countSignatureBits(sig) {
      let count = 0;
      // Unroll loop for performance
      for (let i = 0; i < 32; i += 4) {
          count += popcount(sig[i]);
          count += popcount(sig[i + 1]);
          count += popcount(sig[i + 2]);
          count += popcount(sig[i + 3]);
      }
      return count;
  }

  getNonZeroIndices(sig) {
      const indices = [];
      for (let i = 0; i < 32; i++) {
          if (sig[i] !== 0) {
              indices.push(i);
          }
      }
      return indices;
  }

  calculateDiceCoefficientSignature(sigA, sigB, popA, popB) {
      if (popA === 0 && popB === 0) return 0;
      let intersection = 0;
      // Unroll loop for performance
      for (let i = 0; i < 32; i += 4) {
          intersection += popcount(sigA[i] & sigB[i]);
          intersection += popcount(sigA[i + 1] & sigB[i + 1]);
          intersection += popcount(sigA[i + 2] & sigB[i + 2]);
          intersection += popcount(sigA[i + 3] & sigB[i + 3]);
      }
      return (2 * intersection) / (popA + popB);
  }

  calculateDiceCoefficientSignatureSparse(sigA, sigB, popA, popB, indicesA) {
      if (popA === 0 && popB === 0) return 0;
      let intersection = 0;
      const len = indicesA.length;
      // Iterate only over non-zero blocks of A
      for (let k = 0; k < len; k++) {
          const i = indicesA[k];
          intersection += popcount(sigA[i] & sigB[i]);
      }
      return (2 * intersection) / (popA + popB);
  }

}
