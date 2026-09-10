import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fetch from 'node-fetch';
import { isUnsafeIP } from '../../utils/helpers.js';

export const AI_TIMEOUT_MS = 30000;
export const AI_MAX_BYTES = 512 * 1024;
const specialV6 = new BlockList();
for (const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) specialV6.addSubnet(network,prefix,'ipv6');
export function aiError(code, status = 400) {
    const messages = {
        AI_DISABLED: 'AI is disabled.', AI_FORBIDDEN: 'AI access is not permitted.',
        AI_TARGET_BLOCKED: 'The API target is not permitted.', AI_INVALID_INPUT: 'Invalid AI settings or input.',
        AI_AUTH_FAILED: 'The API rejected the configured credentials.', AI_REDIRECT_BLOCKED: 'API redirects are not permitted.',
        AI_RATE_LIMIT: 'The API or local request limit was reached.', AI_UNAVAILABLE: 'The API is temporarily unavailable.',
        AI_TIMEOUT: 'The API request timed out or was cancelled.', AI_INVALID_RESPONSE: 'The API returned an invalid or incomplete response.',
        AI_RESPONSE_TOO_LARGE: 'The API response exceeded the size limit.', AI_MODEL_REQUIRED: 'Select a successfully tested model.',
        AI_MODEL_UNAVAILABLE: 'The selected model is unavailable; test and select a model again.',
        AI_BUSY: 'An AI request is already running.', AI_PAUSED: 'This connection is temporarily paused after repeated failures.',
        AI_CONNECTION_CHANGED: 'The connection changed during the request. Start again.', AI_NOT_FOUND: 'AI connection not found.'
    };
    return Object.assign(new Error(messages[code] || 'The AI request failed.'), { code, status });
}

export function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//.test(value) || value.length > 2048 || /[\s\\]/.test(value)) throw aiError('AI_INVALID_INPUT');
    let url;
    try { url = new URL(value); } catch { throw aiError('AI_INVALID_INPUT'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%|\/\//.test(url.pathname)) throw aiError('AI_INVALID_INPUT');
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '') || '/v1';
    return url.href.replace(/\/$/, '');
}

function forbiddenAddress(address) {
    if (!isIP(address)) return true;
    if (isIP(address) === 4) {
        const first = Number(address.split('.')[0]);
        return first === 0 || first >= 224 || address.startsWith('169.254.') || address === '100.100.100.200';
    }
    const ip = address.toLowerCase();
    // Never permit link-local, mapped/translated IPv4, multicast or the AWS IPv6 metadata endpoint.
    return /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('::ffff:') || ip.startsWith('64:ff9b:') || ip === 'fd00:ec2::254' || ip === '::';
}
function publicAddress(address) {
    if (forbiddenAddress(address) || isUnsafeIP(address)) return false;
    return isIP(address) === 4 || (/^[23]/.test(address) && !specialV6.check(address,'ipv6'));
}

export async function validateTarget(value, internalTargets = []) {
    const base_url = normalizeBaseUrl(value), url = new URL(base_url);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const internal = internalTargets.includes(base_url);
    if ((!internal && url.protocol !== 'https:') || /(^|\.)metadata\.google\.internal$/.test(host)) throw aiError('AI_TARGET_BLOCKED', 403);
    let addresses;
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true, verbatim: true }); }
    catch { throw aiError('AI_UNAVAILABLE', 502); }
    if (!addresses.length || addresses.some(({ address }) => forbiddenAddress(address) || (!internal && !publicAddress(address)) || (url.protocol === 'http:' && publicAddress(address)))) throw aiError('AI_TARGET_BLOCKED', 403);
    return { base_url, internal, lookup(hostname, options, callback) {
        if (hostname !== host) return callback(aiError('AI_TARGET_BLOCKED', 403));
        const matches = addresses.filter(entry => !options.family || entry.family === options.family);
        if (!matches.length) return callback(aiError('AI_TARGET_BLOCKED', 403));
        if (options.all) callback(null, matches); else callback(null, matches[0].address, matches[0].family);
    } };
}

export async function requestJson(connection, settings, endpoint, { body, signal, beforeSend } = {}) {
    if (!['models', 'chat/completions'].includes(endpoint)) throw aiError('AI_INVALID_INPUT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let agent;
    try {
        if (controller.signal.aborted) throw aiError('AI_TIMEOUT', 504);
        const target = await Promise.race([
            validateTarget(connection.base_url, settings.internal_targets),
            new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(aiError('AI_TIMEOUT', 504)), { once: true }))
        ]);
        if (controller.signal.aborted) throw aiError('AI_TIMEOUT', 504);
        beforeSend?.();
        const Agent = target.base_url.startsWith('https:') ? https.Agent : http.Agent;
        agent = new Agent({ lookup: target.lookup, keepAlive: false, rejectUnauthorized: true });
        const headers = { accept: 'application/json' };
        if (connection.api_key) headers.authorization = `Bearer ${connection.api_key}`;
        if (body) headers['content-type'] = 'application/json';
        const response = await fetch(`${target.base_url}/${endpoint}`, {
            method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
            agent, redirect: 'manual', signal: controller.signal, size: AI_MAX_BYTES
        });
        if (!response.ok) {
            response.body?.destroy();
            if (response.status >= 300 && response.status < 400) throw aiError('AI_REDIRECT_BLOCKED', 502);
            if ([401,403].includes(response.status)) throw aiError('AI_AUTH_FAILED', 502);
            if (response.status === 429) throw aiError('AI_RATE_LIMIT', 429);
            if (response.status === 404) throw aiError('AI_MODEL_UNAVAILABLE', 502);
            throw aiError(response.status >= 500 ? 'AI_UNAVAILABLE' : 'AI_INVALID_RESPONSE', 502);
        }
        if (Number(response.headers.get('content-length')) > AI_MAX_BYTES) { response.body?.destroy(); throw aiError('AI_RESPONSE_TOO_LARGE', 502); }
        let json;
        try { json = JSON.parse(await response.text()); } catch (error) {
            if (error.type === 'max-size') throw aiError('AI_RESPONSE_TOO_LARGE', 502);
            if (controller.signal.aborted) throw aiError('AI_TIMEOUT', 504);
            throw aiError('AI_INVALID_RESPONSE', 502);
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw aiError('AI_INVALID_RESPONSE', 502);
        return json;
    } catch (error) {
        if (error.code?.startsWith('AI_')) throw error;
        throw aiError(controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE', 502);
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); agent?.destroy();
    }
}

// Deliberately bounded JSON Schema subset used by the local feature contracts.
export function validateJson(value, schema, depth = 0) {
    if (!schema || depth > 20) return false;
    if (schema.anyOf) return schema.anyOf.some(candidate => validateJson(value, candidate, depth + 1));
    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
    if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length && !types.includes(type) && !(type === 'number' && types.includes('integer') && Number.isSafeInteger(value))) return false;
    if (type === 'object') {
        if (Object.keys(value).length > 100 || (schema.required || []).some(key => !Object.hasOwn(value,key))) return false;
        for (const [key, item] of Object.entries(value)) {
            if (['__proto__','prototype','constructor'].includes(key)) return false;
            if (Object.hasOwn(schema.properties || {}, key)) { if (!validateJson(item,schema.properties[key],depth+1)) return false; }
            else if (schema.additionalProperties === false) return false;
            else if (typeof schema.additionalProperties === 'object' && !validateJson(item,schema.additionalProperties,depth+1)) return false;
        }
    }
    if (type === 'array' && (value.length > (schema.maxItems ?? 500) || value.length < (schema.minItems ?? 0) || (schema.items && !value.every(item => validateJson(item,schema.items,depth+1))))) return false;
    if (type === 'string' && (value.length > (schema.maxLength ?? 20000) || value.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
    if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
    return true;
}
