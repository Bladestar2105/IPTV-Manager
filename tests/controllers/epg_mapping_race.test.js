import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const state = vi.hoisted(() => ({
  directory: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'iptv-epg-race-')),
  worker: null,
}));
vi.mock('../../src/config/constants.js', () => ({
  DATA_DIR: state.directory, EPG_DB_PATH: `${state.directory}/epg.db`, BCRYPT_ROUNDS: 1,
}));
vi.mock('worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return { Worker: class extends EventEmitter { constructor() { super(); state.worker = this; } } };
});
vi.mock('../../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));
vi.mock('../../src/services/clientResourceService.js', () => ({ createEpgIconUrl: vi.fn() }));
vi.mock('../../src/services/epgService.js', () => ({ loadAllEpgChannels: vi.fn() }));

const { default: db, initDb } = await import('../../src/database/db.js');
const { autoMapping, manualMapping } = await import('../../src/controllers/epgMappingController.js');
const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis() });
beforeAll(() => {
  initDb(true);
  db.exec(`INSERT INTO users(id, username, password) VALUES(1, 'user', 'password');
    INSERT INTO providers(id, name, url, username, password, user_id) VALUES(1, 'Provider', 'https://provider.example', 'u', 'p', 1);
    INSERT INTO provider_channels(id, provider_id, remote_stream_id, name, stream_type) VALUES(1, 1, 10, 'Channel', 'live');`);
});
afterAll(() => { db.close(); fs.rmSync(state.directory, { recursive: true, force: true }); });

it('keeps a manual correction made while automatic matching was running and counts only inserted mappings', async () => {
  const user = { id: 1, is_admin: true, username: 'user' };
  const res = response();
  const pending = autoMapping({ body: { provider_id: 1 }, user, ip: '127.0.0.1' }, res);
  expect(state.worker).toBeTruthy();
  const manualRes = response();
  await manualMapping({ body: { provider_channel_id: 1, epg_channel_id: 'MANUAL' }, user, ip: '127.0.0.1' }, manualRes);
  state.worker.emit('message', { success: true, matched: 1, updates: [{ pid: 1, eid: 'AUTOMATIC' }] });
  await pending;
  expect(db.prepare('SELECT epg_channel_id FROM epg_channel_mappings WHERE provider_channel_id = 1').get())
    .toEqual({ epg_channel_id: 'MANUAL' });
  expect(res.json).toHaveBeenCalledWith({ success: true, matched: 0 });
});
