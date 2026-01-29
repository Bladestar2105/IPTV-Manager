export function cleanName(name) {
  if (!name) return '';
  let cleaned = name.toLowerCase();

  // 1. Remove "Provider|" prefixes (generic)
  cleaned = cleaned.replace(/^[a-z0-9]+\|\s*/, '');

  // 2. Remove Country Codes / Prefixes
  // Pattern: Start + (2-3 letters) + separator or brackets
  cleaned = cleaned.replace(/^[\(\[][a-z]{2,3}[\)\]]\s*/, ''); // (US) Channel
  cleaned = cleaned.replace(/^[a-z]{2,3}\s*[:\|\-]\s*/, ''); // US: Channel, UK - Channel

  // 3. Technical Suffixes (Global)
  // HEVC, FHD, HD, SD, 4K, 8K, RAW, 50FPS, H265, UHD
  cleaned = cleaned.replace(/\b(hevc|fhd|uhd|hd|sd|4k|8k|raw|50fps|h265|h264)\b/g, '');

  // Remove common superscript/styling noise often found in IPTV (e.g. RAW, DE in superscript)
  cleaned = cleaned.replace(/[ᴿᴬᵂᴰᴱ]/g, '');

  // 4. Time shifts (Global)
  cleaned = cleaned.replace(/[\+\-]\d+/g, '');

  // Clean trailing separators/spaces to ensure suffix checks work
  cleaned = cleaned.replace(/[:\|\-_\.\s]+$/, '');

  // 5. TLD Suffixes
  // Remove .de, .gr, .uk, .com, .tv (if at end)
  cleaned = cleaned.replace(/\.[a-z]{2,3}$/, '');

  // 6. -CC Suffix (hyphenated country code at end)
  // "Channel-de" -> "Channel"
  cleaned = cleaned.replace(/\-[a-z]{2}$/, '');

  // 7. Cleanup special chars
  // Replace dots, hyphens, underscores, pipes with space
  cleaned = cleaned.replace(/[\.\-\_\+\|]/g, ' ');

  // 8. Brackets/Parentheses content
  cleaned = cleaned.replace(/\(.*\)/g, '');
  cleaned = cleaned.replace(/\[.*\]/g, '');

  // 9. Common Normalizations
  cleaned = cleaned.replace(/\bplus\b/g, ' '); // "Plus" -> Space
  cleaned = cleaned.replace(/\b(ii)\b/g, '2'); // II -> 2
  cleaned = cleaned.replace(/\b(iii)\b/g, '3'); // III -> 3

  // Remove extra spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

export function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
  }
  return matrix[b.length][a.length];
}
