import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/player.js', import.meta.url), 'utf8');
function element(tag = 'div') {
  let markup = '';
  return { tag, children: [], style: {}, value: '', dataset: {}, classList: { add() {}, remove() {} },
    setAttribute() {}, addEventListener(event, callback) { this[event] = callback; },
    querySelector: () => null, querySelectorAll: () => [], focus() {},
    get innerHTML() { return markup; }, set innerHTML(value) { markup = value; this.children = []; },
    appendChild(child) { if (child.tag === 'fragment') this.children.push(...child.children); else this.children.push(child); } };
}
function player() {
  const requests = [], renders = [], tabs = ['live', 'movie', 'series'].map(type => ({ ...element('a'), dataset: { type } }));
  const listView = element(), loadingEl = element();
  const context = vm.createContext({
    currentType: 'live', allChannels: [], loadedCatalogTypes: new Set(), catalogRequests: new Map(), catalogViewGeneration: 0, seriesDetailGeneration: 0, epgStarted: false,
    listView, loadingEl, catSelect: element('select'), searchInput: element('input'),
    window: {}, document: { createElement: element, createDocumentFragment: () => element('fragment'), querySelectorAll: selector => selector === '#player-tabs .nav-link' ? tabs : [] },
    token: 'session-token', username: null, password: null, getAuthParams: () => 'token=session-token',
    fetch: vi.fn(url => new Promise((resolve, reject) => { requests.push({ url, respond: resolve, resolve: data => resolve({ ok: true, json: async () => data }), reject }); })),
    t: key => key, escapeHtml: value => String(value), console: { error() {}, log() {} }, showToast: vi.fn(),
    renderView: () => { renders.push(context.currentType); }, updateCategories: vi.fn(), updateClearBtnVisibility() {},
    loadEpgSchedule: vi.fn(() => new Promise(() => {})), updateNowPlayingInfo() {},
    requestAnimationFrame() {}, getProxiedUrl: url => url, playStream: vi.fn()
  });
  const methods = ['loadCatalog', 'showCatalog', 'init', 'makeAccessible', 'renderSeriesEpisodes'];
  vm.runInContext(methods.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || '').join('\n'), context);
  vm.runInContext(source.split('// Tab switching')[1].split('// Category filter')[0], context);
  const click = type => { const tab = tabs.find(tab => tab.dataset.type === type); return tab.click({ preventDefault() {}, target: tab, currentTarget: tab }); };
  return { context, requests, renders, listView, loadingEl, click };
}
const settle = () => new Promise(setImmediate);

test('initial player fetches only live channels and renders them before background EPG completes', async () => {
  const p = player();
  const pending = p.context.init();
  expect(p.requests).toHaveLength(1);
  expect(p.requests[0].url).toContain('type=live');
  expect(p.requests[0].url).not.toContain('series=');
  const channels = Array.from({ length: 5001 }, (_, i) => ({ type: 'live', name: `Live ${i}`, group: `Group ${i % 20}` }));
  p.requests[0].resolve(channels);
  await pending;
  expect(p.context.allChannels).toHaveLength(5001);
  expect(p.renders.at(-1)).toBe('live');
  expect(p.context.loadEpgSchedule).toHaveBeenCalledTimes(1);
  expect(p.loadingEl.style.display).toBe('none');
});

test('an uncached tab removes interactive rows immediately and releases loading controls after failure', async () => {
  const p = player();
  p.context.currentType = 'movie';
  p.context.allChannels = [{ type: 'movie', name: 'Old Movie', url: '/movie/old.mp4' }];
  p.context.loadedCatalogTypes.add('movie');
  p.context.timelineView = element();
  p.context.catalogLimit = 0;
  p.context.catalogFilter = '';
  vm.runInContext(['renderView', 'renderList', 'getCatalogRenderLimit', 'appendCatalogContinuation'].map(name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))[0]).join('\n'), p.context);
  p.context.renderView();
  expect(p.listView.children.filter(item => item.tag === 'a')).toHaveLength(1);
  p.click('series');
  expect(p.requests).toHaveLength(1);
  expect(p.listView.style.display).toBe('block');
  expect(p.listView.children.filter(item => item.tag === 'a')).toHaveLength(0);
  expect(p.listView.innerHTML).toContain('role="status"');
  expect(p.context.catSelect.disabled).toBe(true);
  expect(p.context.searchInput.disabled).toBe(true);
  p.requests[0].reject(new Error('temporary failure')); await settle();
  expect(p.context.catSelect.disabled).toBe(false);
  expect(p.context.searchInput.disabled).toBe(false);
  expect(p.listView.children.filter(item => item.tag === 'a')).toHaveLength(0);
  p.click('series'); expect(p.requests).toHaveLength(2);
  p.requests[1].resolve([{ type: 'series', name: 'New Folder', series_id: 77, url: '' }]); await settle();
  expect(p.listView.children.filter(item => item.tag === 'a')).toHaveLength(1);
});

test('tabs load on demand, deduplicate pending requests and reuse complete cached catalogs', async () => {
  const p = player();
  const initial = p.context.init(); p.requests[0].resolve([{ type: 'live', name: 'Live' }]); await initial;
  p.click('series'); p.click('series');
  expect(p.requests).toHaveLength(2);
  expect(p.requests[1].url).toContain('type=series');
  expect(p.requests[1].url).toContain('series=summary');
  p.requests[1].resolve(Array.from({ length: 151 }, (_, i) => ({ type: 'series', series_id: i + 1, name: `Series ${i}`, url: '' })));
  await settle();
  p.click('movie');
  expect(p.requests).toHaveLength(3);
  expect(p.requests[2].url).toContain('type=movie');
  p.requests[2].resolve([{ type: 'movie', name: 'Movie' }]); await settle();
  p.click('live'); await settle(); p.click('series'); await settle();
  expect(p.requests).toHaveLength(3);
  expect(p.context.allChannels.filter(item => item.type === 'series')).toHaveLength(151);
  expect(p.renders.at(-1)).toBe('series');
});

test('late tab responses cache their own items without changing the current tab or loader', async () => {
  const p = player();
  const initial = p.context.init();
  p.click('movie');
  expect(p.requests).toHaveLength(2);
  const rendersBeforeOldResponse = p.renders.slice();
  p.requests[0].resolve([{ type: 'live', name: 'Live' }]); await settle();
  expect(p.renders).toEqual(rendersBeforeOldResponse);
  expect(p.loadingEl.style.display).toBe('flex');
  p.requests[1].resolve([{ type: 'movie', name: 'Movie' }]); await initial; await settle();
  expect(p.renders.at(-1)).toBe('movie');
  expect(p.context.currentType).toBe('movie');
  expect(p.context.allChannels).toHaveLength(2);
});

test('a failed catalog request can be retried and stale failures do not overwrite the current tab', async () => {
  const p = player();
  const initial = p.context.init(); p.requests[0].resolve([]); await initial;
  p.click('movie'); expect(p.requests).toHaveLength(2);
  p.click('series'); expect(p.requests).toHaveLength(3);
  p.requests[1].reject(new Error('old request failed')); await settle();
  expect(p.context.showToast).not.toHaveBeenCalled();
  expect(p.loadingEl.style.display).toBe('flex');
  p.requests[2].resolve([]); await settle();
  p.click('movie'); expect(p.requests).toHaveLength(4);
  p.requests[3].reject(new Error('temporary failure')); await settle();
  expect(p.context.showToast).toHaveBeenCalledTimes(1);
  expect(p.loadingEl.style.display).toBe('none');
  p.click('movie'); expect(p.requests).toHaveLength(5);
  p.requests[4].resolve([{ type: 'movie', name: 'Recovered' }]); await settle();
  expect(p.context.allChannels.find(item => item.type === 'movie').name).toBe('Recovered');
});

test('an HTTP catalog failure leaves the type available for a later retry', async () => {
  const p = player();
  const pending = p.context.init();
  p.requests[0].respond({ ok: false, status: 503 }); await pending;
  expect(p.context.showToast).toHaveBeenCalledTimes(1);
  expect(p.context.loadedCatalogTypes.has('live')).toBe(false);
  p.click('live'); expect(p.requests).toHaveLength(2);
  p.requests[1].resolve([{ type: 'live', name: 'Recovered' }]); await settle();
  expect(p.renders.at(-1)).toBe('live');
});

test.each(['token', 'credentials'])('series folders request local assignment details and construct Manager episode URLs (%s)', async mode => {
  const p = player(); p.context.currentType = 'series';
  if (mode === 'credentials') { p.context.token = null; p.context.username = 'my user'; p.context.password = 'p/a?ss'; }
  const pending = p.context.renderSeriesEpisodes({ type: 'series', series_id: 42, name: 'Folder', url: '' });
  expect(p.requests[0].url).toContain('series_id=42&');
  p.requests[0].resolve({ info: { name: 'Folder' }, episodes: { 1: [{ id: 7001, title: 'Pilot', container_extension: 'mkv', episode_num: 1 }] } });
  await pending;
  const episode = p.listView.children.find(item => item.tag === 'a');
  expect(episode).toBeDefined();
  episode.onclick({ preventDefault() {} });
  expect(p.context.playStream.mock.calls[0][0].url).toBe(mode === 'token' ? '/series/token/auth/7001.mkv?token=session-token' : '/series/my%20user/p%2Fa%3Fss/7001.mkv');
});

test('series details arriving after a tab change cannot replace its catalog', async () => {
  const p = player(); p.context.currentType = 'series';
  const pending = p.context.renderSeriesEpisodes({ series_id: 42, name: 'Folder', url: '' });
  p.click('movie');
  p.listView.innerHTML = 'movie catalog';
  p.requests[0].resolve({ info: {}, episodes: {} }); await pending;
  expect(p.listView.innerHTML).toBe('movie catalog');
});

test('legacy series items retain their existing Manager path when fetching and playing details', async () => {
  const p = player(); p.context.currentType = 'series';
  const pending = p.context.renderSeriesEpisodes({ name: 'Legacy', url: '/series/token/auth/99.mkv?token=session-token' });
  expect(p.requests[0].url).toContain('series_id=99&');
  p.requests[0].resolve({ info: {}, episodes: { 1: [{ id: 7001, title: 'Pilot', container_extension: 'mp4' }] } }); await pending;
  p.listView.children.find(item => item.tag === 'a').onclick({ preventDefault() {} });
  expect(p.context.playStream.mock.calls[0][0].url).toBe('/series/token/auth/7001.mp4?token=session-token');
});
