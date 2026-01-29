export function cleanName(name) {
  if (!name) return '';
  let cleaned = name.toLowerCase();

  // Remove specific provider prefixes "WORD| "
  cleaned = cleaned.replace(/^[a-z0-9]+\|\s*/, '');

  // Remove country codes at start
  // Matches start, code, then word boundary/separator
  cleaned = cleaned.replace(/^(uk|us|de|fr|it|es|pt|pl|tr|gr|nl|be|ch|at)\b\s*[:\|\-]?\s*/, '');
  cleaned = cleaned.replace(/^(uk|us|de|fr|it|es|pt|pl|tr|gr|nl|be|ch|at)[:\|\-]\s*/, '');

  // Remove suffix noise
  // ᴿᴬᵂ (U+1D3F U+1D2C U+1D42), ᴰᴱ (U+1D30 U+1D31)
  cleaned = cleaned.replace(/[ᴿᴬᵂᴰᴱ]/g, '');

  // Remove tech specs
  cleaned = cleaned.replace(/\b(hevc|fhd|hd|sd|4k|8k|raw)\b/g, '');

  // Remove time shifts (+1, +24)
  cleaned = cleaned.replace(/\+\d+/g, '');

  // Remove .de, .gr extension if at end
  cleaned = cleaned.replace(/\.(de|gr)$/, '');

  // Remove "-de" suffix if present as word boundary
  cleaned = cleaned.replace(/\-de\b/, '');

  // Replace special chars with space (including +)
  cleaned = cleaned.replace(/[\.\-\_\+\|]/g, ' ');

  // Remove (text) and [text]
  cleaned = cleaned.replace(/\(.*\)/g, '');
  cleaned = cleaned.replace(/\[.*\]/g, '');

  // Normalizations
  cleaned = cleaned.replace(/\bkabel eins\b/, 'kabel 1');
  cleaned = cleaned.replace(/\bii\b/, '2');
  cleaned = cleaned.replace(/\biii\b/, '3');
  // "plus" -> space
  cleaned = cleaned.replace(/\bplus\b/g, ' ');

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
