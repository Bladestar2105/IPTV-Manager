import { spawn } from 'node:child_process';

// Newline-delimited JSON-RPC 2.0 over the app server's stdio transport, as
// documented for `codex app-server`. The `jsonrpc` member is omitted on the
// wire by the server and is not required on requests.
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

// Server requests that would hand the model a capability. None of them may be
// answered with a grant, and several have no representable deny value, so those
// are answered with a protocol error instead of an invented approval payload.
const DENY_DECISIONS = {
    'item/commandExecution/requestApproval': { decision: 'cancel' },
    'item/fileChange/requestApproval': { decision: 'cancel' },
    execCommandApproval: { decision: 'abort' },
    applyPatchApproval: { decision: 'abort' }
};
const REFUSED_REQUESTS = [
    'item/permissions/requestApproval', 'item/tool/call', 'item/tool/requestUserInput',
    'mcpServer/elicitation/request', 'attestation/generate', 'account/chatgptAuthTokens/refresh'
];

export function codexError(code, message, status = 502) {
    return Object.assign(new Error(message || code), { code, status });
}

export function createClient({ file, args, env, cwd, onNotification, onViolation, onClose } = {}) {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    const state = { closed: false, closeReason: null, budget: DEFAULT_BUDGET_BYTES, nextId: 1, diagnostics: '' };
    let buffer = '';

    const settleAll = error => {
        for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); }
        pending.clear();
    };
    // Reported once, however the runtime ended, so its owner can release the
    // lease and finish whatever was waiting on it instead of holding a dead
    // process open until a timeout.
    // Resolves when the operating system has actually reaped the child, which is
    // later than `close()` returning: closing only sends SIGTERM.
    let markExited;
    const exited = new Promise(resolve => { markExited = resolve; });
    let closeReported = false;
    const reportClose = reason => {
        if (closeReported) return;
        closeReported = true;
        queueMicrotask(() => onClose?.(reason));
    };
    const fail = (code, message) => {
        if (state.closed) return;
        state.closed = true;
        state.closeReason ||= code;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        settleAll(codexError(code, message));
        reportClose(code);
    };
    const write = payload => {
        if (state.closed) throw codexError('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime is not available.');
        const line = `${JSON.stringify(payload)}\n`;
        if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw codexError('AI_INVALID_INPUT', 'Codex request exceeded the message limit.', 400);
        // A runtime that exited between spawn and this write reports EPIPE
        // asynchronously on the pipe, so a synchronous failure here is turned
        // into the same runtime error rather than escaping the caller.
        try { child.stdin.write(line); }
        catch { throw codexError('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime is not available.'); }
    };

    // Any tool, approval or capability request is a boundary violation: the
    // runtime is denied and the caller discards the whole turn.
    const answerServerRequest = message => {
        onViolation?.({ method: message.method, params: message.params });
        if (Object.hasOwn(DENY_DECISIONS, message.method)) {
            try { write({ id: message.id, result: DENY_DECISIONS[message.method] }); } catch { /* runtime already closed */ }
            return;
        }
        try { write({ id: message.id, error: { code: -32601, message: 'Capability is not available to this client.' } }); } catch { /* runtime already closed */ }
    };

    const dispatch = message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.id !== undefined && message.method === undefined) {
            const entry = pending.get(String(message.id));
            if (!entry) return;
            // Bookkeeping belongs to the settler; removing the entry here would
            // make it treat the response as already handled and never settle.
            if (message.error) {
                const detail = typeof message.error?.message === 'string' ? message.error.message : '';
                entry.reject(codexError('AI_CODEX_RPC_ERROR', detail.slice(0, 300)));
            } else entry.resolve(message.result ?? {});
            return;
        }
        if (typeof message.method !== 'string') return;
        if (message.id !== undefined) return answerServerRequest(message);
        if (REFUSED_REQUESTS.includes(message.method)) onViolation?.({ method: message.method, params: message.params });
        onNotification?.(message.method, message.params ?? {});
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        state.budget -= Buffer.byteLength(chunk);
        if (state.budget < 0) return fail('AI_RESPONSE_TOO_LARGE', 'Codex output exceeded the byte budget.');
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return fail('AI_RESPONSE_TOO_LARGE', 'Codex message exceeded the message limit.');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch { continue; }
            dispatch(parsed);
        }
    });
    // Diagnostics stay strictly separate from the protocol stream and are never
    // returned to a client or persisted with a result.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
        state.diagnostics = `${state.diagnostics}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
    });
    // Every pipe needs its own listener. Without one, an EPIPE from a runtime
    // that exited early is an uncaught exception that would take the whole
    // worker down, which an authenticated user could trigger repeatedly.
    child.stdin.on('error', () => fail('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime closed its input.'));
    child.stdout.on('error', () => fail('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime closed its output.'));
    child.stderr.on('error', () => { /* diagnostics are best effort */ });
    child.on('error', () => { markExited(); fail('AI_CODEX_RUNTIME_FAILED', 'Codex runtime could not be started.'); });
    child.on('exit', () => { markExited(); fail('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime exited.'); });

    return {
        pid: child.pid,
        exited,
        get closed() { return state.closed; },
        get closeReason() { return state.closeReason; },
        diagnostics: () => state.diagnostics,
        resetBudget(bytes = DEFAULT_BUDGET_BYTES) { state.budget = bytes; },
        notify(method, params = {}) { write({ method, params }); },
        request(method, params, { timeoutMs = 30000, signal } = {}) {
            return new Promise((resolve, reject) => {
                if (state.closed) return reject(codexError('AI_CODEX_RUNTIME_CLOSED', 'Codex runtime is not available.'));
                const id = state.nextId++;
                const key = String(id);
                const settle = (outcome, value) => {
                    if (!pending.has(key)) return;
                    pending.delete(key);
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    outcome(value);
                };
                const timer = setTimeout(() => settle(reject, codexError('AI_TIMEOUT', 'Codex request timed out.', 504)), timeoutMs);
                const onAbort = () => settle(reject, codexError('AI_TIMEOUT', 'Codex request was cancelled.', 504));
                pending.set(key, { resolve: value => settle(resolve, value), reject: error => settle(reject, error), timer });
                signal?.addEventListener('abort', onAbort, { once: true });
                if (signal?.aborted) return onAbort();
                try { write(params === undefined ? { id, method } : { id, method, params }); }
                catch (error) { settle(reject, error); }
            });
        },
        close(reason = 'AI_CODEX_RUNTIME_CLOSED') {
            if (state.closed) return;
            state.closed = true;
            state.closeReason ||= reason;
            try { child.stdin.destroy(); } catch { /* already closed */ }
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
            hard.unref?.();
            settleAll(codexError(reason, 'Codex runtime was stopped.'));
            reportClose(reason);
        }
    };
}
