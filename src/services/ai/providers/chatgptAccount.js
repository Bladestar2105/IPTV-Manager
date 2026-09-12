import { aiError } from '../transport.js';
import { withRuntime, liveRuntime } from '../codex/runtime.js';
import { requireChatGptAuth, listModels, runTurn } from '../codex/client.js';
import { seal } from '../codex/credentials.js';
import { MODEL_ID } from './openaiApi.js';

export const CODEX_TURN_TIMEOUT_MS = 170000;
export const CODEX_SETUP_TIMEOUT_MS = 60000;

// A Codex error code is translated once, here, into the existing AI error
// vocabulary so the shared limiter, outage breaker and UI keep one contract.
function translate(error) {
    if (error?.code?.startsWith('AI_')) return error;
    return aiError('AI_UNAVAILABLE', 502);
}

// Personal ChatGPT sign-in. The runtime is started for this identity only, used
// for exactly one bounded operation and torn down again; there is no shared
// process that could be switched between personal logins.
export const chatgptAccountProvider = {
    id: 'chatgpt_account',
    // Private by construction: an administrator may enable the feature but can
    // never hand their own sign-in to another account as a service.
    shareable: false,
    requiresBaseUrl: false,
    usesTokenParameter: false,
    supportsAccountLink: true,
    supportsQuota: true,
    // Only deliberately triggered work runs on a personal plan. Automatic sync
    // summaries and unattended catalog analysis stay blocked for this provider.
    allowsUnattended: false,
    requestTimeout(operation) { return operation === 'models' ? CODEX_SETUP_TIMEOUT_MS : CODEX_TURN_TIMEOUT_MS; },
    async execute({ connection, ownerKey, operation, payload, signal, beforeSend }) {
        if (liveRuntime(ownerKey, connection.id)) throw aiError('AI_BUSY', 409);
        try {
            // The orchestrator's own recheck, evaluated inside the lease
            // transaction as well: access can be withdrawn while this request
            // waits for a runtime.
            const verifyEligible = () => { try { beforeSend?.(); return true; } catch { return false; } };
            return await withRuntime(ownerKey, connection.id, async session => {
                await requireChatGptAuth(session);
                // Re-checked immediately before the billable request, exactly as the
                // API transport does.
                beforeSend?.();
                if (operation === 'models') {
                    const models = await listModels(session);
                    const usable = models.filter(model => MODEL_ID.test(model.id));
                    if (!usable.length) throw aiError('AI_INVALID_RESPONSE', 502);
                    return { result: { models: usable }, usage: { prompt_tokens: null, completion_tokens: null } };
                }
                const turn = await runTurn(session, {
                    model: payload.model,
                    messages: payload.messages,
                    schema: payload.schema,
                    structured: payload.structured !== false,
                    maxTokens: payload.maxTokens,
                    signal,
                    timeoutMs: CODEX_TURN_TIMEOUT_MS
                });
                // A token refreshed during the turn is captured before teardown.
                seal(ownerKey, connection.id, {}, { refreshOnly: true });
                return { result: { content: turn.content }, usage: turn.usage };
            }, { verifyEligible });
        } catch (error) { throw translate(error); }
    }
};
