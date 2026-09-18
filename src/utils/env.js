// One resolver for every numeric setting read from the environment.
//
// It lived in five places, each a correct copy of the same parse-check-clamp,
// which is how one of them kept the shape the others had already been fixed out
// of: `EPG_IMPORT_BODY_TIMEOUT_MS=30m` resolved to 1000 ms and killed every EPG
// import a second in, while the documentation said such a value was refused.

const warned = new Set();

function warnOnce(message, key) {
  // Several of these are resolved per call on hot paths — fetchSafe resolves the
  // request budget for every outgoing request — so a misconfigured value would
  // otherwise write one log line per HLS segment per viewer.
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Test seam: forget which warnings have already been emitted. */
export function resetEnvWarnings() {
  warned.clear();
}

const INTEGER = /^\s*\d+\s*$/;

/**
 * A positive integer setting from the environment.
 *
 * Two failure modes, opposite to each other, both of which have bitten here:
 * `Number(raw) || fallback` accepts a negative number because it is truthy, and
 * a negative `maxBytes` reaches readBodyWithLimit as no limit at all — removing
 * the cap it was set to tighten. `Number.parseInt` instead keeps the leading
 * digits, so `30s` becomes 30 and `512MB` becomes 512, and clamping that to a
 * floor turns a five minute budget into one second.
 *
 * So anything that is not a clean positive integer is refused outright and the
 * default is used, which is the one outcome that is never worse than the
 * operator's intent. The floor and ceiling then apply only to a value that was
 * meant literally. Both paths say so once, naming the variable.
 *
 * @param {unknown} raw the environment value
 * @param {number} fallback used when `raw` is absent or unusable
 * @param {number} [min] floor for a value meant literally
 * @param {number} [max] ceiling for a value meant literally
 * @param {string|null} [name] the variable's name, for the log line
 */
export function resolveBudget(raw, fallback, min = 1, max = Number.MAX_SAFE_INTEGER, name = null) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  if (!INTEGER.test(String(raw))) {
    if (name) {
      warnOnce(`⚠️ ${name}="${raw}" is not a plain integer (no unit suffixes); using ${fallback}`,
        `${name}:${raw}`);
    }
    return fallback;
  }

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (name) warnOnce(`⚠️ ${name}="${raw}" is not a positive integer; using ${fallback}`, `${name}:${raw}`);
    return fallback;
  }

  const resolved = Math.min(Math.max(parsed, min), max);
  if (name && resolved !== parsed) {
    warnOnce(`⚠️ ${name}=${parsed} is outside the supported range; using ${resolved}`, `${name}:${raw}`);
  }
  return resolved;
}
