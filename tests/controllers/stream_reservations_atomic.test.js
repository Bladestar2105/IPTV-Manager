import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import streamManager from '../../src/services/streamManager.js';

const state = vi.hoisted(() => ({ providers: [], channel: {} }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({
  all: () => state.providers,
  get: () => ({ ...state.channel }),
}) } }));
vi.mock('../../src/utils/crypto.js', () => ({ encrypt: value => value, decrypt: value => value }));
const { reserveChannelSession, reserveProviderSession, reserveGrantedResourceSession } = await import('../../src/controllers/streamControllerHelpers.js');

let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE current_streams (id TEXT PRIMARY KEY, user_id INTEGER, username TEXT,
    channel_name TEXT, start_time INTEGER, last_activity INTEGER, ip TEXT, worker_pid INTEGER, provider_id INTEGER)`);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, is_active INTEGER, token_version INTEGER, expiry_date TEXT);
    INSERT INTO users VALUES (1, 1, 0, NULL), (2, 1, 0, NULL)`);
  streamManager.localStreams.clear();
  streamManager.init(db, null);
  state.providers = [{ id: 1, url: 'https://provider.example', max_connections: 0 }];
  state.channel = { user_channel_id: 1, provider_id: 1, provider_url: 'https://provider.example', name: 'Channel' };
});
afterEach(() => { db.close(); streamManager.localStreams.clear(); });

describe.each(['channel', 'provider', 'grant'])('atomic %s admission', kind => {
  async function reserve(id, user, sessionName = id, ip = id) {
    const req = { ip };
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn(), destroy: vi.fn() };
    if (kind === 'channel') return reserveChannelSession(id, user, { ...state.channel }, req, res, sessionName, { dedupe: false });
    if (kind === 'provider') return reserveProviderSession(id, user, state.providers[0], req, res, sessionName, { dedupe: false });
    return reserveGrantedResourceSession(id, user, 1, 1, req, res, sessionName);
  }

  it('admits only one simultaneous start at the user limit', async () => {
    const user = { id: 1, username: 'one', max_connections: 1 };
    const results = await Promise.all([reserve('a', user), reserve('b', user)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await streamManager.getUserConnectionCount(1)).toBe(1);
  });

  it('admits only one simultaneous start at the provider limit', async () => {
    state.providers[0].max_connections = 1;
    const results = await Promise.all([reserve('a', { id: 1 }), reserve('b', { id: 2 })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await streamManager.getProviderConnectionCount(1)).toBe(1);
  });

  it('keeps same-session socket reuse within one slot', async () => {
    state.providers[0].max_connections = 1;
    const user = { id: 1, max_connections: 1 };
    const results = await Promise.all([reserve('a', user, 'same', 'same-ip'), reserve('b', user, 'same', 'same-ip')]);
    expect(results.every(Boolean)).toBe(true);
    expect(await streamManager.getUserConnectionCount(1)).toBe(1);
    expect(await streamManager.getProviderConnectionCount(1)).toBe(1);
  });
});

it('stops a foreign owner resource before releasing its shared SQLite row', async () => {
  const owner = new streamManager.constructor();
  owner.init(db, null);
  owner.pid = process.pid + 100;
  const resource = { destroy: vi.fn(() => {
    expect(db.prepare('SELECT id FROM current_streams WHERE id = ?').get('foreign')).toBeTruthy();
  }) };
  await owner.add('foreign', { id: 1 }, 'Live', 'ip', resource, 1);
  streamManager.isWorkerAlive = () => true;
  streamManager.forwardTermination = async message => {
    const success = await owner.remove(message.streamId);
    streamManager.handleTerminationReply({ ...message, success });
  };
  await streamManager.remove('foreign');
  expect(resource.destroy).toHaveBeenCalledOnce();
  expect(await streamManager.getAll()).toHaveLength(0);
  delete streamManager.isWorkerAlive;
  delete streamManager.forwardTermination;
});
