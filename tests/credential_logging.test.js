import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A provider URL carries the panel account in its query string, and an Xtream
// media URL carries it in its path. Anything that interpolates one into a log
// line writes a decrypted upstream password to stdout, where it lands in the
// container log and is kept for as long as the log is rotated — which is what
// happened for the episode sync, the EPG import and the segment proxy, each
// found separately and each an easy line to add again.
//
// So this is checked mechanically rather than per call site: every log
// statement that interpolates a URL-shaped expression must put it through
// `redactUrl` or `sanitizeErrorMessage`.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const LOG_CALL = /console\.(log|info|warn|error|debug)\(/;
const INTERPOLATION = /\$\{([^}]*)\}/g;
const REDACTED = /redactUrl\(|sanitizeErrorMessage\(/;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function unredactedUrlLogs(file) {
  const found = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!LOG_CALL.test(line)) return;
    INTERPOLATION.lastIndex = 0;
    let match;
    while ((match = INTERPOLATION.exec(line)) !== null) {
      const expression = match[1];
      if (!/url/i.test(expression)) continue;
      if (REDACTED.test(expression)) continue;
      found.push(`${file.slice(SRC.length + 1)}:${index + 1} — \${${expression}}`);
    }
  });
  return found;
}

describe('credentials in log statements', () => {
  it('never interpolates an unredacted URL into a log line', () => {
    const offenders = sourceFiles(SRC).flatMap(unredactedUrlLogs);

    expect(offenders).toEqual([]);
  });

  it('recognises an offending line, so the check above cannot pass vacuously', () => {
    const offending = [
      'src/x.js',
      '  console.error(`EPG update failed: ${url}`, e.message);',
    ].join('\n');
    const lines = offending.split('\n');
    const matched = lines.some(line => {
      if (!LOG_CALL.test(line)) return false;
      INTERPOLATION.lastIndex = 0;
      const match = INTERPOLATION.exec(line);
      return Boolean(match) && /url/i.test(match[1]) && !REDACTED.test(match[1]);
    });

    expect(matched).toBe(true);
  });
});
