import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
function functions(...names) {
  return names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] || '').join('\n');
}
function element() {
  const classes = new Set();
  return { value: 'previous secret', innerHTML: 'previous private rows', textContent: '', checked: false,
    style: {}, dataset: {}, classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle() {} },
    setAttribute() {}, removeAttribute() {}, reset() {}, querySelectorAll: () => [], children: [], appendChild(child) { this.children.push(child); } };
}
function browser(fetch = vi.fn()) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const passwords = [element(), element()];
  const context = vm.createContext({
    fetch, sessionGeneration: 1, currentUser: { id: 1, is_admin: true }, getToken: () => 'token', isTokenExpired: () => false,
    document: { getElementById: get, createElement: () => element(), querySelectorAll: selector => selector.includes('input') ? passwords : [] },
    window: { location: { href: 'http://manager.test/', origin: 'http://manager.test' } }, URL, bootstrap: { Modal: { getInstance: () => null } },
    stopMaintenancePolling() {}, updateChannelProviderSelect() {}, setEpgMappingJobProgress() {}, formatDuration: () => '0',
    setInterval, clearInterval, t: key => key, console: { error() {} }, setLoadingState() {},
    updateStatsCounters: vi.fn(), setToken: vi.fn(), hideLoginModal() {}, applyPermissions() {}, alert() {},
    categorySortable: null, channelSortable: null, statsInterval: null, globalStatsInterval: null,
    globalSelectedChannels: new Set([1]), editingShareToken: 'private', currentSyncConfig: {}, availableEpgSources: [],
    selectedUserId: 1, selectedUser: { id: 1 }, selectedCategoryId: 1,
    removeToken: vi.fn(), showLoginModal: vi.fn(), refreshCurrentUserPermissions: vi.fn()
  });
  vm.runInContext(functions('escapeHtml', 'getProxiedUrl', 'isAuthenticationFailure', 'fetchJSON', 'switchView', 'clearAdminSensitiveState', 'clearSessionSensitiveState', 'loadSecurity', 'loadSharesList', 'loadStatistics', 'loadEpgSources', 'handleExport', 'handleLogin', 'loadProviders', 'renderEpgMappingChannels', 'loadEpgSuggestions', 'filterEpgSelectionList'), context);
  return { context, get, passwords };
}

test('session cleanup hides privileged views and clears settings, private rows and password fields', () => {
  const { context, get, passwords } = browser();
  get('view-security').classList.remove('d-none');
  context.clearSessionSensitiveState();
  expect(get('view-security').classList.contains('d-none')).toBe(true);
  expect(get('view-dashboard').classList.contains('d-none')).toBe(false);
  for (const id of ['security-logs-tbody', 'client-logs-tbody', 'active-streams-tbody', 'epg-sources-list', 'shares-list-tbody', 'stalker-device-list', 'export-user-select', 'copy-user-select', 'editing-share-name-display']) expect(get(id).innerHTML, id).toBe('');
  expect(get('editing-share-banner').classList.contains('d-none')).toBe(true);
  expect(get('setting-geoip-license-key').value).toBe('');
  expect(passwords.map(input => input.value)).toEqual(['', '']);
});

test.each(['statistics', 'mapping', 'suggestions', 'selection'])('%s escapes same-origin image paths before rendering HTML attributes', async view => {
  const { context, get } = browser();
  const logo = '/"><button data-action="action-disable-otp">click</button><img src="/';
  const channel = { id: 1, name: 'News', logo };
  get('epg-mapping-search').value = '';
  get('epg-select-search').value = '';
  context.epgMappingChannels = [channel];
  context.currentMappingChannelId = 1;
  context.availableEpgChannels = [{ ...channel, id: 'news' }];
  context.isLoadingEpgChannels = false;
  let container;
  if (view === 'statistics') {
    context.fetchJSON = async () => ({ active_streams: [{ ...channel, username: 'Viewer', channel_name: 'News' }], top_channels: [] });
    await context.loadStatistics();
    container = get('active-streams-tbody');
  } else if (view === 'mapping') {
    context.renderEpgMappingChannels();
    container = get('epg-mapping-tbody');
  } else if (view === 'suggestions') {
    context.fetchJSON = async () => ({ suggestions: [{ confidence: 1, epgChannel: { ...channel, id: 'news' } }] });
    await context.loadEpgSuggestions(1);
    container = get('epg-suggest-list');
  } else {
    context.filterEpgSelectionList();
    container = get('epg-select-list');
  }
  expect(container.children).toHaveLength(1);
  expect(container.children[0].innerHTML).not.toContain('<button data-action="action-disable-otp">');
  expect(container.children[0].innerHTML).toContain('&lt;button data-action=&quot;action-disable-otp&quot;&gt;');
});

test('provider owner labels cannot inject management actions', async () => {
  const { context, get } = browser();
  context.fetchJSON = async () => [{ id: 1, user_id: 1, name: 'Provider', url: 'http://example.test', owner_name: '<button data-action="action-disable-otp">click</button>' }];
  await context.loadProviders();
  const markup = get('provider-list').children[0].children[0].innerHTML;
  expect(markup).not.toContain('<button data-action="action-disable-otp">');
  expect(markup).toContain('&lt;button data-action=&quot;action-disable-otp&quot;&gt;');
});

test.each(['response', 'json'])('a stale %s cannot return prior-session data or sign out the next user', async phase => {
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  const res = { ok: true, status: 200, json: () => phase === 'json' ? wait : Promise.resolve({ secret: 'previous' }) };
  const { context } = browser(() => phase === 'response' ? wait : Promise.resolve(res));
  const result = context.fetchJSON('/api/settings');
  await Promise.resolve();
  context.sessionGeneration++;
  context.currentUser = { id: 2 };
  resume(phase === 'response' ? res : { secret: 'previous' });
  await expect(result).rejects.toThrow();
  expect(context.removeToken).not.toHaveBeenCalled();
});

test('a late authentication rejection cannot revoke a newer login', async () => {
  let resume;
  const { context } = browser(() => new Promise(resolve => { resume = resolve; }));
  const result = context.fetchJSON('/api/settings');
  context.sessionGeneration++;
  context.currentUser = { id: 2 };
  resume({ status: 401, ok: false, clone: () => ({ json: async () => ({ error: 'Invalid or expired token' }) }) });
  await expect(result).rejects.toThrow();
  expect(context.removeToken).not.toHaveBeenCalled();
  expect(context.currentUser.id).toBe(2);
});

test('a security settings response arriving after logout cannot repopulate the license key', async () => {
  let resume;
  const { context, get } = browser();
  context.fetchJSON = url => url === '/api/settings' ? new Promise(resolve => { resume = resolve; }) : Promise.resolve([]);
  const pending = context.loadSecurity();
  context.sessionGeneration++;
  context.currentUser = { id: 2, is_admin: false };
  get('setting-geoip-license-key').value = '';
  resume({ geoip_license_key: 'admin-only-key' });
  await pending;
  expect(get('setting-geoip-license-key').value).toBe('');
});

test.each(['loadStatistics', 'loadEpgSources'])('%s ignores privileged results after the account changes', async method => {
  let resume;
  const { context } = browser();
  context.fetchJSON = () => new Promise(resolve => { resume = resolve; });
  const pending = context[method]();
  context.sessionGeneration++;
  context.currentUser = { id: 2, is_admin: false };
  resume(method === 'loadStatistics' ? { active_streams: [], top_channels: [] } : []);
  await pending;
  expect(context.updateStatsCounters).not.toHaveBeenCalled();
});

test('a backup response completed after logout cannot start a download in the next session', async () => {
  let resume;
  const { context } = browser(async () => ({ ok: true, blob: () => new Promise(resolve => { resume = resolve; }) }));
  const createObjectURL = vi.fn(() => 'blob:private');
  context.window.URL = { createObjectURL };
  const pending = context.handleExport({ preventDefault() {}, target: { user_id: { value: '1' }, password: { value: 'long-password' } } });
  await new Promise(setImmediate);
  context.sessionGeneration++;
  context.currentUser = { id: 2, is_admin: false };
  resume({});
  await pending;
  expect(createObjectURL).not.toHaveBeenCalled();
});

test('a delayed login response cannot replace a newer account', async () => {
  let resume;
  const { context } = browser(async () => ({ ok: true, json: () => new Promise(resolve => { resume = resolve; }) }));
  const pending = context.handleLogin({ preventDefault() {} });
  await new Promise(setImmediate);
  context.sessionGeneration++;
  context.currentUser = { id: 2, is_admin: false };
  resume({ token: 'late-old-token', user: { id: 1, is_admin: true } });
  await pending;
  expect(context.currentUser.id).toBe(2);
  expect(context.setToken).not.toHaveBeenCalled();
});

test('share names, links and embedded JSON are escaped without interpreting entity payloads', async () => {
  const { context, get } = browser();
  context.fetchJSON = async () => [{ name: '<img src=x onerror=alert(1)> &quot; &#39;', channel_count: 1,
    token: 'token" onclick="evil', link: 'https://example.test/" onfocus="evil', channels: '[]' }];
  await context.loadSharesList();
  const markup = get('shares-list-tbody').children[0].innerHTML;
  expect(markup).not.toContain('<img src=x');
  expect(markup).not.toContain('value="https://example.test/" onfocus=');
  expect(markup).not.toContain('data-token="token" onclick=');
  const encoded = markup.match(/data-share='([^']*)'/)[1];
  const decoded = encoded.replace(/&(?:amp|quot|lt|gt|#039|#39);/g, entity => ({ '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#039;': "'", '&#39;': "'" })[entity]);
  expect(JSON.parse(decoded).name).toBe('<img src=x onerror=alert(1)> &quot; &#39;');
});
