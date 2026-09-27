import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
vi.mock('../src/utils/crypto.js', () => ({ JWT_SECRET: 'test', decrypt: v => v, encrypt: v => v }));
vi.mock('../src/database/db.js', () => ({ default: db }));
const queue = vi.hoisted(() => ({ enqueueMaintenanceJobs: vi.fn(), listMaintenanceJobs: vi.fn() }));
vi.mock('../src/services/maintenanceQueueService.js', () => queue);
vi.mock('../src/services/syncService.js', () => ({ performSync: vi.fn(), checkProviderExpiry: vi.fn(), deleteAllProviderChannels: vi.fn() }));
vi.mock('../src/services/epgService.js', () => ({
  loadAllEpgChannels: vi.fn(), updateEpgSource: vi.fn(), updateProviderEpg: vi.fn(),
  deleteEpgSourceData: vi.fn(), getProgramsNow: vi.fn(), getProgramsScheduleForChannels: vi.fn(), clearEpgData: vi.fn()
}));
vi.mock('../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));
const { syncProvider, getMaintenanceJobs } = await import('../src/controllers/providerController.js');
const { triggerUpdateEpgSource, updateAllEpgSources } = await import('../src/controllers/epgController.js');
const { performSync } = await import('../src/services/syncService.js');
const { updateProviderEpg, updateEpgSource } = await import('../src/services/epgService.js');
const actor = { id: 9, is_admin: true };
const jobs = [{ id: 1, type: 'provider_sync', target_id: 7, user_id: 1, status: 'queued' }];
function request(id = '7', body = { enqueue: true, user_id: 1 }) { return { user: actor, params: { id }, body }; }
function response() {
  const res = { statusCode: 200, body: undefined };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  return res;
}
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users VALUES (1);
  CREATE TABLE providers (id INTEGER PRIMARY KEY, epg_enabled INTEGER); INSERT INTO providers VALUES (7, 1), (8, 0);
  CREATE TABLE epg_sources (id INTEGER PRIMARY KEY, enabled INTEGER); INSERT INTO epg_sources VALUES (3, 1), (4, 0);`);
afterAll(() => db.close());
beforeEach(() => { vi.clearAllMocks(); queue.enqueueMaintenanceJobs.mockResolvedValue(jobs); queue.listMaintenanceJobs.mockResolvedValue(jobs); });
it('accepts provider sync without starting upstream work in the request', async () => {
  const res = response();
  await syncProvider(request('7', { enqueue: true, user_id: 1, allow_cross_owner: true, restore_revoked_assignments: true }), res);
  expect(res.statusCode).toBe(202);
  expect(res.body).toEqual({ success: true, status: 'queued', jobs });
  expect(queue.enqueueMaintenanceJobs).toHaveBeenCalledWith(actor, [{ type: 'provider_sync', target_id: 7, user_id: 1, allow_cross_owner: true, restore_revoked_assignments: true }]);
  expect(performSync).not.toHaveBeenCalled();
});
it.each([['0', 1, 400], ['7', -1, 400], ['999', 1, 404], ['7', 999, 404]])('validates provider/user before acceptance %s/%s', async (id, user_id, status) => {
  const res = response(); await syncProvider(request(id, { enqueue: true, user_id }), res);
  expect(res.statusCode).toBe(status); expect(queue.enqueueMaintenanceJobs).not.toHaveBeenCalled();
});
it.each([['3', 'epg_source', 3], ['provider_7', 'provider_epg', 7]])('accepts EPG source %s', async (id, type, target_id) => {
  const res = response(); await triggerUpdateEpgSource(request(id), res);
  expect(res.statusCode).toBe(202); expect(res.body.jobs).toEqual(jobs);
  expect(queue.enqueueMaintenanceJobs).toHaveBeenCalledWith(actor, [{ type, target_id }]);
  expect(updateProviderEpg).not.toHaveBeenCalled(); expect(updateEpgSource).not.toHaveBeenCalled();
});
it.each([['0', 400], ['provider_x', 400], ['99', 404], ['provider_99', 404]])('validates EPG target %s', async (id, status) => {
  const res = response(); await triggerUpdateEpgSource(request(id), res);
  expect(res.statusCode).toBe(status); expect(queue.enqueueMaintenanceJobs).not.toHaveBeenCalled();
});
it('accepts update-all as one batch of enabled sources', async () => {
  const res = response(); await updateAllEpgSources(request(), res);
  expect(res.statusCode).toBe(202);
  expect(queue.enqueueMaintenanceJobs).toHaveBeenCalledExactlyOnceWith(actor, [
    { type: 'provider_epg', target_id: 7, skip_prune: true }, { type: 'epg_source', target_id: 3, skip_prune: true }
  ]);
});
it('lists jobs for administrators', async () => {
  const res = response(); await getMaintenanceJobs(request(), res);
  expect(res.statusCode).toBe(200); expect(res.body).toEqual(jobs);
});
it.each(['provider', 'source', 'all', 'list'])('rejects normal users for %s', async kind => {
  const handler = { provider: syncProvider, source: triggerUpdateEpgSource, all: updateAllEpgSources, list: getMaintenanceJobs }[kind];
  const res = response(); await handler({ ...request(), user: { id: 1, is_admin: false } }, res);
  expect(res.statusCode).toBe(403); expect(queue.enqueueMaintenanceJobs).not.toHaveBeenCalled(); expect(queue.listMaintenanceJobs).not.toHaveBeenCalled();
});
it.each([['SQLITE_BUSY', undefined, 503], [undefined, 403, 403], [undefined, undefined, 500]])('does not claim acceptance on queue failure', async (code, status, expected) => {
  queue.enqueueMaintenanceJobs.mockRejectedValueOnce(Object.assign(new Error('https://secret:password@upstream.test'), { code, status }));
  const res = response(); await syncProvider(request(), res);
  expect(res.statusCode).toBe(expected); expect(JSON.stringify(res.body)).not.toContain('password');
});
it('sends a response for synchronous provider EPG updates', async () => {
  const res = response(); await triggerUpdateEpgSource(request('provider_7', {}), res);
  expect(res.body).toEqual({ success: true }); expect(updateProviderEpg).toHaveBeenCalledWith(7);
});

it('accepts an empty enabled EPG batch', async () => {
  db.exec('UPDATE providers SET epg_enabled = 0; UPDATE epg_sources SET enabled = 0;');
  try {
    queue.enqueueMaintenanceJobs.mockResolvedValueOnce([]);
    const res = response(); await updateAllEpgSources(request(), res);
    expect(res.statusCode).toBe(202); expect(res.body.jobs).toEqual([]);
    expect(queue.enqueueMaintenanceJobs).toHaveBeenCalledWith(actor, []);
  } finally {
    db.exec('UPDATE providers SET epg_enabled = 1 WHERE id = 7; UPDATE epg_sources SET enabled = 1 WHERE id = 3;');
  }
});
it.each(['source', 'all', 'list'])('sanitizes queue failure for %s', async kind => {
  const error = Object.assign(new Error('https://secret:password@upstream.test'), { code: 'SQLITE_BUSY' });
  if (kind === 'list') queue.listMaintenanceJobs.mockRejectedValueOnce(error);
  else queue.enqueueMaintenanceJobs.mockRejectedValueOnce(error);
  const handler = { source: triggerUpdateEpgSource, all: updateAllEpgSources, list: getMaintenanceJobs }[kind];
  const res = response(); await handler(request('3'), res);
  expect(res.statusCode).toBe(503); expect(JSON.stringify(res.body)).not.toContain('password');
});
