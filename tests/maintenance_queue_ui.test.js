import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function browser(jobs = []) {
  const nodes = new Map();
  const node = () => ({ getClientRects: () => [], hidden: true, textContent: '', children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
  const context = vm.createContext({
    sessionGeneration: 0, currentUser: { is_admin: true }, maintenanceJobs: new Map(), maintenancePoll: null, maintenanceGeneration: 0,
    loadEpgSources: vi.fn(async () => {}), fetchJSON: vi.fn(async () => jobs), showToast: vi.fn(), t: (key, args) => key + (args ? JSON.stringify(args) : ''),
    setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node }
  });
  vm.runInContext(source.match(/(?:async )?function (?:renderMaintenanceJobs|stopMaintenancePolling|refreshMaintenanceJobs|enqueueMaintenanceJob)\([^\n]*\) \{[\s\S]*?\n\}/g)?.join('\n') || '', context);
  return { context, nodes };
}

test('acceptance requests enqueue and shows waiting information without false success counts', async () => {
  const { context } = browser();
  context.fetchJSON.mockResolvedValueOnce({ status: 'queued', jobs: [{ id: 'one', type: 'provider_sync', target_id: 4, status: 'queued' }] });
  expect(typeof context.enqueueMaintenanceJob).toBe('function');
  await context.enqueueMaintenanceJob('/api/providers/4/sync', { user_id: 2 });
  expect(JSON.parse(context.fetchJSON.mock.calls[0][1].body)).toEqual({ user_id: 2, enqueue: true });
  expect(context.showToast).toHaveBeenCalledWith('maintenanceAccepted', 'info');
  expect(JSON.stringify(context.showToast.mock.calls)).not.toContain('syncSuccess');
});

test('queue displays waiting, running and escaped task errors, then stops polling when empty', async () => {
  const { context, nodes } = browser([
    { id: '1', type: 'provider_sync', target_id: 4, status: 'queued' },
    { id: '2', type: 'epg_source', target_id: 5, status: 'running' },
    { id: '3', type: 'provider_epg', target_id: 6, status: 'error', error: '<img onerror=alert(1)>' }
  ]);
  expect(typeof context.refreshMaintenanceJobs).toBe('function');
  await context.refreshMaintenanceJobs();
  const lines = nodes.get('maintenance-jobs-list').children.map(item => item.textContent).join(' ');
  expect(lines).toContain('maintenanceQueued');
  expect(lines).toContain('maintenanceRunning');
  expect(lines).toContain('<img onerror=alert(1)>');
  expect(context.setTimeout).toHaveBeenCalledOnce();
  expect(context.showToast).not.toHaveBeenCalled();
  context.fetchJSON.mockResolvedValue([]);
  context.setTimeout.mockClear();
  await context.refreshMaintenanceJobs();
  expect(nodes.get('maintenance-jobs-list').textContent).toBe('maintenanceEmpty');
  expect(context.setTimeout).not.toHaveBeenCalled();
});

test('permission loss clears queue and prevents in-flight poll from restoring it', async () => {
  const { context, nodes } = browser();
  let finish;
  context.fetchJSON.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  expect(typeof context.refreshMaintenanceJobs).toBe('function');
  const pending = context.refreshMaintenanceJobs();
  context.currentUser = null;
  context.stopMaintenancePolling();
  finish([{ id: '1', status: 'running' }]);
  await pending;
  expect(nodes.get('maintenance-jobs').hidden).toBe(true);
  expect(context.maintenanceJobs.size).toBe(0);
  expect(context.setTimeout).not.toHaveBeenCalled();
});

test('a rejected acceptance reports queue failure and never announces completion', async () => {
  const { context } = browser();
  context.fetchJSON.mockRejectedValue(new Error('offline'));
  await expect(context.enqueueMaintenanceJob('/api/epg-sources/update-all')).rejects.toThrow('maintenanceAcceptFailed offline');
  expect(context.showToast).not.toHaveBeenCalled();
  expect(context.maintenanceJobs.size).toBe(0);
});

test('non-admin sessions never request queue status', async () => {
  const { context, nodes } = browser();
  context.currentUser = { is_admin: false };
  await context.refreshMaintenanceJobs();
  expect(context.fetchJSON).not.toHaveBeenCalled();
  expect(nodes.get('maintenance-jobs').hidden).toBe(true);
});

test('repeated snapshots replace jobs by ID without completion toast storms', async () => {
  const { context, nodes } = browser([{ id: '1', type: 'epg_source', target_id: 5, status: 'success' }]);
  await context.refreshMaintenanceJobs();
  await context.refreshMaintenanceJobs();
  expect(nodes.get('maintenance-jobs-list').children).toHaveLength(1);
  expect(nodes.get('maintenance-jobs-list').children[0].textContent).toContain('maintenanceSuccess');
  expect(context.showToast).not.toHaveBeenCalled();
  expect(context.setTimeout).not.toHaveBeenCalled();
});

test('incomplete provider results never display undefined success counts', async () => {
  const { context, nodes } = browser([{ id: '1', type: 'provider_sync', target_id: 5, status: 'success', result: { channels_added: 1 } }]);
  await context.refreshMaintenanceJobs();
  expect(nodes.get('maintenance-jobs-list').children[0].textContent).not.toContain('syncSuccess');
});

test('status failures stay visible and retry without reporting task failure', async () => {
  const { context, nodes } = browser();
  context.fetchJSON.mockRejectedValue(new Error('offline'));
  await context.refreshMaintenanceJobs();
  expect(nodes.get('maintenance-jobs')?.hidden).toBe(false);
  expect(nodes.get('maintenance-jobs-error').textContent).toBe('maintenanceUnavailable');
  expect(context.setTimeout).toHaveBeenCalledWith(context.refreshMaintenanceJobs, 5000);
  expect(context.showToast).not.toHaveBeenCalled();
});

test('finishing a queued task refreshes visible EPG rows once, not historical snapshots', async () => {
  const active = { id: '1', type: 'epg_source', target_id: 5, status: 'running' };
  const { context } = browser([active]);
  context.document.getElementById('epg-sources-list').getClientRects = () => [{}];
  await context.refreshMaintenanceJobs();
  expect(context.loadEpgSources).not.toHaveBeenCalled();
  context.fetchJSON.mockResolvedValue([{...active, status: 'success'}]);
  await context.refreshMaintenanceJobs();
  expect(context.loadEpgSources).toHaveBeenCalledOnce();
  await context.refreshMaintenanceJobs();
  expect(context.loadEpgSources).toHaveBeenCalledOnce();
});
