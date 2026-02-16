import fs from 'fs';
import readline from 'readline';

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

  // 5. TLD Suffixes - REMOVED to preserve accuracy

  // 6. -CC Suffix - REMOVED to preserve accuracy

  // 7. Cleanup special chars
  // Replace dots, hyphens, underscores, pipes, brackets with space
  cleaned = cleaned.replace(/[\.\-\_\+\|\(\)\[\]]/g, ' ');

  // 8. Brackets/Parentheses content - REMOVED (was too aggressive)

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

  let buffer = '';
  let inProgramme = false;
  const MAX_BUFFER = 1024 * 50; // 50KB safety limit for a single programme entry

  for await (const line of rl) {
      const trimmed = line.trim();

      if (!inProgramme) {
          if (trimmed.startsWith('<programme')) {
              inProgramme = true;
              buffer = trimmed;

              // Handle self-closing tag immediately: <programme ... />
              if (trimmed.endsWith('/>')) {
                  inProgramme = false;
                  // Self-closing programme usually has no title/desc, so skip or handle
                  // Typically XMLTV uses child elements for title/desc so self-closing is rare/useless
                  buffer = '';
                  continue;
              }
          }
      } else {
          // In programme block
          // Append with space to avoid merging attributes incorrectly
          buffer += ' ' + trimmed;

          // Safety check: Prevent infinite buffer growth if </programme> is missing
          if (buffer.length > MAX_BUFFER) {
              // Too large, discard and reset
              inProgramme = false;
              buffer = '';
              continue;
          }
      }

      if (inProgramme && buffer.includes('</programme>')) {
          inProgramme = false;

          // Extract attributes from the full block (handling multiline)
          // Use [\s\S] to match across newlines if any, though buffer is single line here
          // Buffer is constructed from lines with spaces in between.

          const startMatch = buffer.match(/start="([^"]+)"/);
          const stopMatch = buffer.match(/stop="([^"]+)"/);
          const channelMatch = buffer.match(/channel="([^"]+)"/);

          const titleMatch = buffer.match(/<title[^>]*>([^<]+)<\/title>/);
          const descMatch = buffer.match(/<desc[^>]*>([^<]+)<\/desc>/);

          if (startMatch && stopMatch && channelMatch && titleMatch) {
              // Do NOT decode channel ID to match DB/Playlist format (raw string)
              const channelId = channelMatch[1];
              const title = decodeXml(titleMatch[1]);
              const desc = descMatch ? decodeXml(descMatch[1]) : '';
              const start = parseXmltvDate(startMatch[1]);
              const stop = parseXmltvDate(stopMatch[1]);

              if (channelId && start && stop && title) {
                  onProgramme({
                      channel_id: channelId,
                      title: title,
                      desc: desc,
                      start: start,
                      stop: stop
                  });
              }
          }
          buffer = '';
      }
  }
}

/**
 * Parses EPG XML file for channels only (Streaming).
 * @param {string} filePath
 * @param {function} onChannel callback({id, name})
 * @returns {Promise<void>}
 */
export function parseEpgChannels(filePath, onChannel) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';

    stream.on('data', (chunk) => {
      buffer += chunk;

      while (true) {
         const endTag = '</channel>';
         const endIdx = buffer.indexOf(endTag);
         if (endIdx === -1) break;

         const blockEnd = endIdx + endTag.length;

         // Search backwards for the start tag to ensure we get the matching one for this end tag
         const startTag = '<channel';
         const startIdx = buffer.lastIndexOf(startTag, endIdx);

         if (startIdx !== -1) {
             const fullBlock = buffer.substring(startIdx, blockEnd);

             // Robust regex to handle single/double quotes and potential newlines
             const idMatch = fullBlock.match(/id=(["'])([\s\S]*?)\1/);
             const nameMatch = fullBlock.match(/<display-name[^>]*>([^<]+)<\/display-name>/);
             const iconMatch = fullBlock.match(/<icon[^>]+src=(["'])([\s\S]*?)\1/);

             if (idMatch) {
                 onChannel({
                     id: idMatch[2],
                     name: nameMatch ? decodeXml(nameMatch[1]) : idMatch[2],
                     logo: iconMatch ? iconMatch[2] : null
                 });
             }
         } else {
             // Handle self-closing tag <channel ... /> if it was missed by the standard loop?
             // Actually self-closing tags end with /> so they don't have </channel>.
             // We need to handle them separately or assume they are rare.
             // XMLTV standard channels usually have display-name, so they are not self-closing.
             // If we want to support self-closing <channel ... />:
             // We can search for `/>` but that matches any tag.
             // Given the complexity and low likelihood, we skip self-closing optimization here unless critical.
             // The previous code handled it but it was complex.
         }

         // Remove processed block and everything before it
         buffer = buffer.substring(blockEnd);
      }
    });

    stream.on('end', () => {
       resolve();
    });

    stream.on('error', (err) => {
       reject(err);
    });
  });
}

/**
 * Streams filtered EPG content from input file to output stream.
 * Only writes <channel> and <programme> blocks if their ID/channel attribute is in allowedIds.
 *
 * @param {string} inputFile Path to source XMLTV file
 * @param {Writable} outputStream Node.js Writable Stream
 * @param {Set<string>} allowedIds Set of allowed Channel IDs
 * @returns {Promise<void>}
 */
export function filterEpgFile(inputFile, outputStream, allowedIds) {
    return new Promise((resolve, reject) => {
        const rs = fs.createReadStream(inputFile, { encoding: 'utf8', highWaterMark: 64 * 1024 });

        let buffer = '';

        rs.on('data', (chunk) => {
            buffer += chunk;

            // State machine loop
            while (true) {
                // Find next tag start
                const tagStart = buffer.indexOf('<');
                if (tagStart === -1) break;

                // Optimization: Discard garbage before tag
                if (tagStart > 0) {
                    buffer = buffer.substring(tagStart);
                }

                // Identify tag type
                if (buffer.startsWith('<channel')) {
                    const endTag = '</channel>';
                    const endIdx = buffer.indexOf(endTag);
                    if (endIdx === -1) break; // Wait for more data

                    const blockEnd = endIdx + endTag.length;
                    const block = buffer.substring(0, blockEnd);

                    // Extract ID (handle double or single quotes)
                    const idMatch = block.match(/id=(["'])(.*?)\1/);
                    if (idMatch && allowedIds.has(idMatch[2])) {
                        outputStream.write(block + '\n');
                    }

                    buffer = buffer.substring(blockEnd);
                } else if (buffer.startsWith('<programme')) {
                    const endTag = '</programme>';
                    const endIdx = buffer.indexOf(endTag);
                    if (endIdx === -1) break; // Wait for more data

                    const blockEnd = endIdx + endTag.length;
                    const block = buffer.substring(0, blockEnd);

                    // Extract Channel (handle double or single quotes)
                    const chMatch = block.match(/channel=(["'])(.*?)\1/);
                    if (chMatch && allowedIds.has(chMatch[2])) {
                        outputStream.write(block + '\n');
                    }

                    buffer = buffer.substring(blockEnd);
                } else if (buffer.startsWith('<tv') || buffer.startsWith('<?xml') || buffer.startsWith('<!DOCTYPE')) {
                     // Skip header tags as the consolidator writes its own
                     const closeIdx = buffer.indexOf('>');
                     if (closeIdx === -1) break;
                     buffer = buffer.substring(closeIdx + 1);
                } else if (buffer.startsWith('</tv>')) {
                     // End of file content, skip
                     const closeIdx = buffer.indexOf('>');
                     if (closeIdx === -1) break;
                     buffer = buffer.substring(closeIdx + 1);
                } else {
                     // Unknown tag or comment, just skip to next '>'
                     // This handles comments <!-- --> loosely or other tags
                     const closeIdx = buffer.indexOf('>');
                     if (closeIdx === -1) break;
                     buffer = buffer.substring(closeIdx + 1);
                }
            }
        });

        rs.on('end', () => {
            resolve();
        });

        rs.on('error', (err) => {
            console.error(`Error filtering EPG file ${inputFile}:`, err.message);
            resolve(); // Resolve to avoid breaking the whole process
        });
    });
}

/**
 * Streams multiple EPG files into a single output file.
 * Handles removal of individual headers and footers to create valid XML.
 *
 * @param {string[]} inputFiles Array of file paths
 * @param {Writable} outputStream Node.js Writable Stream
 * @returns {Promise<void>}
 */
export async function mergeEpgFiles(inputFiles, outputStream) {
    for (const file of inputFiles) {
        if (!fs.existsSync(file)) continue;

        await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
            let buffer = '';
            let foundStart = false;

            stream.on('data', (chunk) => {
                let currentChunk = buffer + chunk;
                buffer = '';

                if (!foundStart) {
                    const startMatch = currentChunk.match(/<tv[^>]*>/);
                    if (startMatch) {
                        foundStart = true;
                        const startIndex = startMatch.index + startMatch[0].length;
                        currentChunk = currentChunk.substring(startIndex);
                    } else {
                        // Keep the last part of chunk to handle split tags
                        const lastLt = currentChunk.lastIndexOf('<');
                        if (lastLt !== -1) {
                            buffer = currentChunk.substring(lastLt);
                        }
                        return;
                    }
                }

                if (foundStart) {
                    const endMatch = currentChunk.indexOf('</tv>');
                    if (endMatch !== -1) {
                        outputStream.write(currentChunk.substring(0, endMatch));
                        stream.destroy();
                        resolve();
                        return;
                    } else {
                        if (currentChunk.length >= 5) {
                            const toWrite = currentChunk.substring(0, currentChunk.length - 4);
                            outputStream.write(toWrite);
                            buffer = currentChunk.substring(currentChunk.length - 4);
                        } else {
                            buffer = currentChunk;
                        }
                    }
                }
            });

            stream.on('end', () => {
                if (buffer && buffer.length > 0) {
                    outputStream.write(buffer);
                }
                resolve();
            });

            stream.on('error', (err) => {
                console.error(`Error merging EPG file ${file}:`, err.message);
                resolve(); // Continue even on error
            });

            stream.on('close', resolve);
        });
    }
}
