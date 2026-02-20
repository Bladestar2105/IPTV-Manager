export function decodeXml(str) {
  if (!str) return '';
  return str.replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
}

export function cleanName(name) {
  if (!name) return '';
  let cleaned = name.toLowerCase();

  // 1. Remove "Provider|" prefixes (generic)
  cleaned = cleaned.replace(/^[a-z0-9]+\|\s*/, '');

  // 2. Remove Country Codes / Prefixes
  // Re-enabled to allow fuzzy matching (e.g. RTL (DE) -> RTL)
  // Disambiguation handles the conflicts (RTL DE vs RTL NL) via original name similarity
  cleaned = cleaned.replace(/\b(de|at|ch|us|uk|en|gr|nl|be|fr|it|es|pl|tr|ru|ger|usa)\b/g, '');

  // 3. Technical Suffixes (Global)
  // HEVC, FHD, HD, SD, 4K, 8K, RAW, 50FPS, H265, UHD
  cleaned = cleaned.replace(/\b(hevc|fhd|uhd|hd|sd|4k|8k|raw|50fps|h265|h264)\b/g, '');

  // Remove common superscript/styling noise often found in IPTV (e.g. RAW, DE in superscript)
  cleaned = cleaned.replace(/[ᴿᴬᵂᴰᴱ]/g, '');

  // 4. Time shifts (Global)
  cleaned = cleaned.replace(/[\+\-]\d+/g, '');

  // Clean trailing separators/spaces to ensure suffix checks work
  cleaned = cleaned.replace(/[:\|\-_\.\s]+$/, '');

  // 7. Cleanup special chars
  // Replace dots, hyphens, underscores, pipes, brackets with space
  cleaned = cleaned.replace(/[\.\-\_\+\|\(\)\[\]]/g, ' ');

  // 9. Common Normalizations
  cleaned = cleaned.replace(/\bplus\b/g, ' '); // "Plus" -> Space
  cleaned = cleaned.replace(/\b(ii)\b/g, '2'); // II -> 2
  cleaned = cleaned.replace(/\b(iii)\b/g, '3'); // III -> 3
  cleaned = cleaned.replace(/\bone\b/g, '1'); // One -> 1

  // Remove extra spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

const MAX_ROW_SIZE = 256;
const _rowBuffer = new Int32Array(MAX_ROW_SIZE);

export function levenshtein(a, b, limit = Infinity) {
  if (a.length === 0) return b.length <= limit ? b.length : limit + 1;
  if (b.length === 0) return a.length <= limit ? a.length : limit + 1;

  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  // Swap to ensure a is the shorter string to minimize memory usage
  if (a.length > b.length) [a, b] = [b, a];

  let row;
  if (a.length < MAX_ROW_SIZE) {
    row = _rowBuffer;
  } else {
    // Fallback for very long strings
    row = new Int32Array(a.length + 1);
  }

  // Use Int32Array for better performance
  for (let i = 0; i <= a.length; i++) row[i] = i;

  for (let i = 1; i <= b.length; i++) {
    let prevDiag = row[0];
    row[0] = i;
    let minRowDist = row[0];

    for (let j = 1; j <= a.length; j++) {
      const oldRowJ = row[j];
      if (b.charCodeAt(i - 1) === a.charCodeAt(j - 1)) {
        row[j] = prevDiag;
      } else {
        // row[j-1] is the new left value (insertion)
        // oldRowJ is the top value (deletion)
        // prevDiag is the diagonal (substitution)
        row[j] = Math.min(prevDiag, row[j - 1], oldRowJ) + 1;
      }
      prevDiag = oldRowJ;
      if (row[j] < minRowDist) minRowDist = row[j];
    }

    if (minRowDist > limit) return limit + 1;
  }
  return row[a.length] <= limit ? row[a.length] : limit + 1;
}

/**
 * Calculates similarity between two strings (0.0 to 1.0)
 * 1.0 = Exact Match
 * 0.0 = Completely different
 */
export function getSimilarity(s1, s2, threshold = 0) {
  if (s1 === s2) return 1.0;
  const len = Math.max(s1.length, s2.length);
  if (len === 0) return 1.0;

  const limit = Math.floor(len * (1 - threshold));
  const dist = levenshtein(s1, s2, limit);

  if (dist > limit) return 0;
  return Math.max(0, 1 - (dist / len));
}
