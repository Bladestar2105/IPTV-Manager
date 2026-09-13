import path from 'node:path';
import { DATA_DIR } from '../../../config/constants.js';

// The ChatGPT account adapter drives the officially documented Codex app server
// over JSON-RPC. Only the protocol surface of a pinned, tested Codex release is
// used; an unknown release keeps the adapter disabled instead of guessing.
export const TESTED_CODEX_VERSION = '0.154.0';
export const SUPPORTED_CODEX_RANGE = { minimum: '0.154.0', below: '0.156.0' };

// Verification targets published by the documented ChatGPT sign-in flow. A
// verification address that is not covered here is never opened or returned.
export const LOGIN_VERIFICATION_HOSTS = ['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'];

// Codex feature flags that expose execution, file, browser, plugin or discovery
// tooling. They are disabled explicitly; `--strict-config` makes a renamed or
// removed flag a hard startup failure rather than a silent capability grant.
export const DISABLED_CODEX_FEATURES = [
    'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'sleep_tool',
    'view_image', 'image_generation', 'computer_use',
    'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser',
    'in_app_chat', 'in_app_dictation', 'in_app_local_automation',
    'apps', 'hooks', 'remote_plugin', 'recommended_plugins',
    'skill_search', 'skill_mcp_dependency_install', 'tool_suggest',
    'tool_call_mcp_elicitation', 'auth_elicitation', 'workspace_dependencies', 'code_mode_host'
];

// Configuration overrides applied on top of the disabled features. These are
// validated by `--strict-config` on every start.
export const CODEX_CONFIG_OVERRIDES = [
    'tools.web_search=false',
    'mcp_servers={}',
    'sandbox_mode="read-only"',
    'approval_policy="on-request"',
    'shell_environment_policy.inherit="none"',
    'history.persistence="none"',
    'analytics.enabled=false',
    'forced_login_method="chatgpt"',
    'cli_auth_credentials_store="file"',
    'projects={}'
];

const flag = (name, fallback = false) => {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

// Disabled by default. Hosting a managed multi-user ChatGPT sign-in needs an
// explicit operator decision plus a verified isolation backend; neither is
// implied by the presence of the Codex binary.
export const codexConfig = () => ({
    enabled: flag('AI_CODEX_ENABLED', false),
    binary: process.env.AI_CODEX_BIN || 'codex',
    runtimeDir: process.env.AI_CODEX_RUNTIME_DIR || path.join(DATA_DIR, 'ai-codex'),
    sandbox: (process.env.AI_CODEX_SANDBOX || 'auto').toLowerCase(),
    // Operators who accepted a documented weaker isolation grade opt in explicitly.
    allowDevelopmentSandbox: flag('AI_CODEX_ALLOW_DEV_SANDBOX', false),
    versionOverride: process.env.AI_CODEX_VERSION_OVERRIDE || null
});

// One version token: numbers plus any prerelease or build suffix. The probe and
// the handshake must read the same string, or an operator's exact-version
// override would be accepted by one and rejected by the other.
export const VERSION_TOKEN = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';

export function compareVersions(left, right) {
    const parse = value => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
    const [a, b] = [parse(left), parse(right)];
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff) return diff < 0 ? -1 : 1;
    }
    return 0;
}

export function versionSupported(version) {
    // Exactly a release version. A prerelease or a build-tagged binary is not the
    // tested release even when its numbers fall inside the range, so it stays
    // unavailable unless an operator names that exact string in
    // `AI_CODEX_VERSION_OVERRIDE`.
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
    return compareVersions(version, SUPPORTED_CODEX_RANGE.minimum) >= 0
        && compareVersions(version, SUPPORTED_CODEX_RANGE.below) < 0;
}

export function verificationUrlAllowed(value) {
    if (typeof value !== 'string' || value.length > 2048) return false;
    let url;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return LOGIN_VERIFICATION_HOSTS.includes(url.hostname.toLowerCase());
}
