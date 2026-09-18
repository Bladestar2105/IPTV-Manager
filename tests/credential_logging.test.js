import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A provider URL carries the panel account in its query string, and an Xtream
// media URL carries it in its path. Anything that puts one in a log line writes
// a decrypted upstream password to stdout, where it stays for as long as the
// container log is kept — which is what happened for the episode sync, the EPG
// import and the segment proxy, each found separately and each an easy line to
// add again. So it is checked mechanically rather than per call site.
//
// What this guarantees, exactly: no single line under src/ passes a URL-shaped
// expression to console.* or process.std{out,err}.write without putting it
// through redactUrl or sanitizeErrorMessage first.
//
// What it does NOT see, and what therefore still needs a human:
//   - a log call spread over more than one line;
//   - a URL held in a variable whose name does not contain "url";
//   - a URL reached through an object, e.g. JSON.stringify(provider);
//   - any logger that is not console.* or process.std*.write — in particular
//     the access log, whose redaction lives in the morgan 'url' token in
//     src/app.js and is the only thing keeping every request line clean.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const LOG_CALL = /(console\.(log|info|warn|error|debug)|process\.std(out|err)\.write)\s*\(/;
const REDACTING_CALL = /\b(redactUrl|sanitizeErrorMessage)\s*\([^()]*\)/g;
const URLISH = /\b[A-Za-z_$][\w$]*[uU][rR][lL][\w$]*\b|\burl\b/;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/**
 * The argument text of a log call, with everything already redacted removed —
 * and with string literals removed too, so prose like "backup_urls column" is
 * not mistaken for a variable.
 */
function unredactedArguments(line) {
  const call = line.slice(line.search(LOG_CALL));
  return call
    .replace(REDACTING_CALL, '')
    // A template literal keeps only its interpolations: prose like
    // "Failed to parse backup_urls" is text, not a variable carrying a URL.
    .replace(/`(?:[^`\\]|\\.)*`/g, literal => (literal.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function unredactedUrlLogs(file) {
  const found = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!LOG_CALL.test(line)) return;
    const args = unredactedArguments(line);
    if (!URLISH.test(args)) return;
    found.push(`${file.slice(SRC.length + 1)}:${index + 1} — ${line.trim().slice(0, 120)}`);
  });
  return found;
}

describe('credentials in log statements', () => {
  it('never interpolates an unredacted URL into a log line', () => {
    const offenders = sourceFiles(SRC).flatMap(unredactedUrlLogs);

    expect(offenders).toEqual([]);
  });

  it('recognises the shapes it claims to catch', () => {
    const offending = [
      'console.error(`EPG update failed: ${url}`, e.message);',
      'console.error("Segment upstream error for", targetUrl);',
      'console.log(feedUrl);',
      'process.stdout.write(`${provider.epg_url}\\n`);',
    ];
    for (const line of offending) {
      expect(LOG_CALL.test(line) && URLISH.test(unredactedArguments(line))).toBe(true);
    }
  });

  it('does not flag a redacted call or prose that merely mentions a url', () => {
    const clean = [
      'console.error(`EPG update failed: ${redactUrl(url)}`, sanitizeErrorMessage(e));',
      "console.log('✅ DB Migration: backup_urls column created');",
      'console.warn(`Failed to parse backup_urls (${label}):`, e.message);',
      'console.debug(`Episode sync for source ${sourceKey} skipped`);',
    ];
    for (const line of clean) {
      expect(LOG_CALL.test(line) && URLISH.test(unredactedArguments(line))).toBe(false);
    }
  });
});
