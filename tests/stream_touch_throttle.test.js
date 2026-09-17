import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE current_streams (
    id TEXT PRIMARY KEY, user_id INTEGER, username TEXT, channel_name TEXT,
    start_time INTEGER, last_activity INTEGER, ip TEXT, worker_pid INTEGER, provider_id INTEGER
  );
`);

const streamManager = (await import('../src/services/streamManager.js')).default;

const user = { id: 1, username: 'u' };
const lastActivity = id => memDb.prepare('SELECT last_activity FROM current_streams WHERE id = ?').get(id)?.last_activity;

describe('stream activity throttle', () => {
  beforeEach(() => {
    memDb.prepare('DELETE FROM current_streams').run();
    streamManager.init(memDb, null);
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    memDb.close();
  });

  it('collapses the flood of progress events into one write per window', async () => {
    await streamManager.add('s1', user, 'Channel', '10.0.0.1', null, 1, { dedupe: false });
    const afterAdd = lastActivity('s1');

    // ffmpeg fires `progress` about once per second per stream; each of those
    // used to be its own UPDATE on the shared database.
    for (let i = 0; i < 100; i++) await streamManager.touch('s1');
    expect(lastActivity('s1')).toBe(afterAdd);
  });

  it('writes again once the window has passed', async () => {
    await streamManager.add('s2', user, 'Channel', '10.0.0.2', null, 1, { dedupe: false });
    const afterAdd = lastActivity('s2');

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 120000));
    await streamManager.touch('s2');
    vi.useRealTimers();

    expect(lastActivity('s2')).toBeGreaterThan(afterAdd);
  });

  it('honours an explicit force', async () => {
    await streamManager.add('s3', user, 'Channel', '10.0.0.3', null, 1, { dedupe: false });
    memDb.prepare('UPDATE current_streams SET last_activity = 0 WHERE id = ?').run('s3');

    await streamManager.touch('s3');
    expect(lastActivity('s3')).toBe(0);

    await streamManager.touch('s3', { force: true });
    expect(lastActivity('s3')).toBeGreaterThan(0);
  });

  it('forgets a session so a reused id is not silently throttled', async () => {
    await streamManager.add('s4', user, 'Channel', '10.0.0.4', null, 1, { dedupe: false });
    await streamManager.remove('s4');

    await streamManager.add('s4', user, 'Channel', '10.0.0.4', null, 1, { dedupe: false });
    memDb.prepare('UPDATE current_streams SET last_activity = 0 WHERE id = ?').run('s4');
    await streamManager.touch('s4', { force: true });
    expect(lastActivity('s4')).toBeGreaterThan(0);
  });
});
