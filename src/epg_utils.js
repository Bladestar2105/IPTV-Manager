import fs from 'fs';
import readline from 'readline';

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

/**
 * Parses XMLTV date string: YYYYMMDDHHMMSS +/-HHMM
 * Returns Unix timestamp (seconds)
 */
function parseXmltvDate(dateStr) {
  if (!dateStr) return 0;
  // Format: 20080715003000 +0100
  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+\-]\d{4})?$/);
  if (!match) return 0;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // 0-indexed
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  // Construct date in UTC first
  let date = new Date(Date.UTC(year, month, day, hour, minute, second));

  // Apply timezone offset if present
  if (match[7]) {
      const tz = match[7];
      const sign = tz.charAt(0) === '+' ? 1 : -1;
      const tzHour = parseInt(tz.substring(1, 3), 10);
      const tzMin = parseInt(tz.substring(3, 5), 10);
      const offsetMs = (tzHour * 60 + tzMin) * 60 * 1000 * sign;

      // XMLTV date is local time + offset. To get UTC, we subtract offset.
      // Actually standard is: LocalTime = UTC + Offset.
      // So UTC = LocalTime - Offset.
      date = new Date(date.getTime() - offsetMs);
  }

  return Math.floor(date.getTime() / 1000);
}

/**
 * Parses EPG XML file and invokes callback for each programme.
 * @param {string} filePath
 * @param {function} onProgramme callback({channel_id, start, stop, title, desc})
 * @returns {Promise<void>}
 */
export async function parseEpgXml(filePath, onProgramme) {
  const fileStream = fs.createReadStream(filePath);

  const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
  });

  let currentProg = null;
  let buffer = '';

  // Simple state machine
  // We look for <programme ...> to start
  // We collect until </programme>
  // We extract data

  for await (const line of rl) {
      const trimmed = line.trim();

      if (trimmed.startsWith('<programme')) {
          buffer = trimmed;
          currentProg = {};

          // Quick extract attributes from the opening tag
          const startMatch = trimmed.match(/start="([^"]+)"/);
          const stopMatch = trimmed.match(/stop="([^"]+)"/);
          const channelMatch = trimmed.match(/channel="([^"]+)"/);

          if (startMatch) currentProg.start = parseXmltvDate(startMatch[1]);
          if (stopMatch) currentProg.stop = parseXmltvDate(stopMatch[1]);
          if (channelMatch) currentProg.channel_id = channelMatch[1];
      }

      if (currentProg) {
          if (!buffer.includes(trimmed)) {
             buffer += ' ' + trimmed; // Append if not start line
          }

          if (trimmed.includes('</programme>')) {
              // Parse Title
              const titleMatch = buffer.match(/<title[^>]*>([^<]+)<\/title>/);
              if (titleMatch) currentProg.title = titleMatch[1]; // decode entities if needed

              // Parse Desc
              const descMatch = buffer.match(/<desc[^>]*>([^<]+)<\/desc>/);
              if (descMatch) currentProg.desc = descMatch[1];

              // Validate and emit
              if (currentProg.channel_id && currentProg.start && currentProg.stop && currentProg.title) {
                  onProgramme(currentProg);
              }

              currentProg = null;
              buffer = '';
          }
      }
  }
}
