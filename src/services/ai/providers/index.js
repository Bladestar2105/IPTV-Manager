import { aiError, AI_TIMEOUT_MS } from '../transport.js';
import { openaiApiProvider, MODEL_ID } from './openaiApi.js';
import { chatgptAccountProvider } from './chatgptAccount.js';

export { MODEL_ID };
export const DEFAULT_PROVIDER = 'openai_api';
export const PROVIDERS = [openaiApiProvider, chatgptAccountProvider];
const BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]));

export const PROVIDER_IDS = [...BY_ID.keys()];

// Connections stored before this feature carry no provider marker and stay on
// the existing OpenAI-compatible API transport.
export function providerOf(connection) {
    const id = connection?.provider;
    return typeof id === 'string' && BY_ID.has(id) ? id : DEFAULT_PROVIDER;
}

export function adapterFor(connection) {
    return BY_ID.get(providerOf(connection));
}

export function normalizeProvider(value) {
    if (value === undefined || value === null) return DEFAULT_PROVIDER;
    if (typeof value !== 'string' || !BY_ID.has(value)) throw aiError('AI_INVALID_INPUT');
    return value;
}

export function providerTimeout(connection, operation) {
    const adapter = adapterFor(connection);
    return adapter.requestTimeout?.(operation) ?? AI_TIMEOUT_MS;
}
