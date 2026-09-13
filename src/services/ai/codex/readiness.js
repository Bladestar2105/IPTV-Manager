import { codexConfig } from './config.js';
import { codexAvailability } from './runtime.js';
import { resetIsolationCache } from './isolation.js';

// The isolation self-test spawns a probe process, so readiness is resolved once
// in the background and then read synchronously by request handlers. An
// unresolved or failed probe never reads as "available".
let snapshot = null;
let inflight = null;

const disabled = () => ({ available: false, reason: 'AI_CODEX_DISABLED' });

export function codexReadinessSnapshot() {
    if (!codexConfig().enabled) return disabled();
    return snapshot || { available: false, reason: 'AI_CODEX_NOT_READY' };
}

export async function refreshCodexReadiness({ force = false } = {}) {
    if (!codexConfig().enabled) { snapshot = null; return disabled(); }
    if (force) { resetIsolationCache(); inflight = null; }
    if (!inflight) {
        inflight = codexAvailability({ force })
            .then(result => { snapshot = result; return result; })
            .catch(() => { snapshot = { available: false, reason: 'AI_CODEX_NOT_READY' }; return snapshot; })
            .finally(() => { inflight = null; });
    }
    return inflight;
}

export function resetCodexReadiness() { snapshot = null; inflight = null; resetIsolationCache(); }
