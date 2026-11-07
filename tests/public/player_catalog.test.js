import { expect, test } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/player.js', import.meta.url), 'utf8');
function element(tag = 'div') {
  return { tag, children: [], style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, focus() { this.focused = true; },
    set innerHTML(_value) { this.children = []; },
    appendChild(child) { if (child.tag === 'fragment') this.children.push(...child.children); else this.children.push(child); },
    querySelectorAll(selector) { return this.children.filter(child => child.className?.split(' ').includes(selector.slice(1))); } };
}
function player(type, count) {
  const listView = element(), sidebarEl = element();
  const context = vm.createContext({
    currentType: type, allChannels: Array.from({ length: count }, (_, i) => ({ name: `Channel ${i}`, group: i % 2 ? 'odd' : 'even', type, epg_id: `id-${i}` })),
    catSelect: { value: '' }, searchInput: { value: '' }, listView, sidebarEl,
    timelineView: element(), epgRowsEl: element(), timeHeaderEl: element(), epgGridEl: element(),
    document: { createElement: element, createDocumentFragment: () => element('fragment') },
    t: key => key, getProxiedUrl: url => url, activeStream: null, currentChannels: [], epgSchedule: {},
    TIMELINE_HOURS: 1, PIXELS_PER_MINUTE: 4, ROW_HEIGHT: 48, timelineStart: 0,
    catalogLimit: 0, catalogFilter: '', seriesDetailGeneration: 0, programTimeFormatter: new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }), positionTooltip() {}, updateCurrentTimeLine() {}
  });
  const methods = ['makeAccessible', 'getCatalogRenderLimit', 'appendCatalogContinuation', 'renderView', 'renderList', 'renderTimeline'];
  vm.runInContext(methods.map(name => source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || '').join('\n'), context);
  return { context, container: type === 'live' ? sidebarEl : listView };
}

test.each([['movie', 150], ['series', 150], ['live', 200]])('%s catalogs can continue beyond the first %i rows and retain expanded results during refresh', (type, firstPage) => {
  const { context, container } = player(type, firstPage * 2 + 1);
  context.renderView();
  expect(container.children.filter(node => node.tag !== 'button')).toHaveLength(firstPage);
  let more = container.children.find(node => node.tag === 'button');
  expect(more?.textContent).toContain('loadMore');
  expect(more?.type).toBe('button');
  more.onclick();
  expect(container.children.filter(node => node.tag !== 'button')).toHaveLength(firstPage * 2);
  expect(container.children[firstPage].focused).toBe(true);
  context.renderView();
  expect(container.children.filter(node => node.tag !== 'button')).toHaveLength(firstPage * 2);
  more = container.children.find(node => node.tag === 'button');
  more.onclick();
  expect(container.children).toHaveLength(firstPage * 2 + 1);
  expect(container.children.some(node => node.tag === 'button')).toBe(false);
});

test('EPG redraws reuse one time formatter across all program bars', () => {
  const { context } = player('live', 1);
  let constructions = 0, formats = 0;
  context.Intl = { DateTimeFormat: class { constructor() { constructions++; } format() { formats++; return 'formatted time'; } } };
  context.Date = class extends Date { toLocaleTimeString() { throw new Error('repeated locale formatter construction'); } };
  vm.runInContext(source.match(/const programTimeFormatter = [^\n]+;/)?.[0] || '', context);
  context.TIMELINE_HOURS = 36;
  context.epgSchedule = { 'id-0': Array.from({ length: 100 }, (_, i) => ({ start: i * 60, stop: (i + 1) * 60, title: `Program ${i}` })) };
  context.renderTimeline(); context.renderTimeline();
  expect(constructions).toBe(1);
  expect(formats).toBeGreaterThanOrEqual(200);
  expect(context.epgRowsEl.children[0].children[0].children[0].textContent).toBe('formatted time');
});

test.each(['movie', 'series', 'live'])('%s category and search changes reset the page and retain all matches', type => {
  const { context, container } = player(type, 501);
  context.renderView();
  const more = container.children.find(node => node.tag === 'button');
  expect(more).toBeDefined();
  more.onclick();
  context.catSelect.value = 'odd';
  context.searchInput.value = 'Channel 499';
  context.renderView();
  expect(container.children).toHaveLength(1);
  context.searchInput.value = '';
  context.renderView();
  expect(container.children.filter(node => node.tag !== 'button')).toHaveLength(type === 'live' ? 200 : 150);
  container.children.find(node => node.tag === 'button').onclick();
  expect(container.children).toHaveLength(250);
});
