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

  it('writes the heartbeat through the latency connection', async () => {
    // Regression: the latency connection was assigned but the statement was
    // still prepared from the shared one, so a contended heartbeat could block
    // the worker for the full batch timeout.
    const latency = new Database(':memory:');
    latency.exec('CREATE TABLE marker (v INTEGER)');
    const prepared = [];
    latency.prepare = new Proxy(latency.prepare, {
      apply(target, thisArg, args) { prepared.push(args[0]); return Reflect.apply(target, thisArg, args); },
    });
    try {
      streamManager.init(memDb, null, latency);
      expect(prepared.some(sql => /UPDATE current_streams SET last_activity/i.test(sql))).toBe(true);
    } finally {
      latency.close();
      streamManager.init(memDb, null);
    }
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

  it('prunes throttle timestamps of sessions it will never see again', async () => {
    // A session another worker's stale sweep removed never reaches remove()
    // here, so without pruning the map only ever grows.
    for (let i = 0; i < 12005; i++) streamManager.lastTouchAt.set(`ghost-${i}`, Date.now() - 48 * 3600 * 1000);
    expect(streamManager.lastTouchAt.size).toBeGreaterThan(10000);

    await streamManager.add('live', user, 'Channel', '10.0.0.9', null, 1, { dedupe: false });
    await streamManager.touch('live', { force: true });

    expect(streamManager.lastTouchAt.size).toBeLessThanOrEqual(10000);
    streamManager.lastTouchAt.clear();
  });

  it('does not let concurrent progress events pile up behind a slow Redis write', async () => {
    // The Redis path awaits two round trips, and every caller is
    // fire-and-forget. Claiming the window only after the write meant that a
    // round trip slower than ffmpeg's ~1s progress cadence turned one heartbeat
    // into one pair of Redis commands per progress event, per stream, per
    // worker — applied exactly when the store is already struggling.
    const record = JSON.stringify({ id: 'r1', last_activity: 1 });
    const calls = { hGet: 0, hSet: 0 };
    const slow = value => new Promise(resolve => setTimeout(() => resolve(value), 30));
    const redis = {
      hGet: () => { calls.hGet++; return slow(record); },
      hSet: () => { calls.hSet++; return slow('OK'); },
    };
    streamManager.init(null, redis);
    try {
      streamManager.lastTouchAt.delete('r1');
      await Promise.all(Array.from({ length: 10 }, () => streamManager.touch('r1')));

      expect(calls.hGet).toBe(1);
      expect(calls.hSet).toBe(1);
    } finally {
      streamManager.lastTouchAt.delete('r1');
      streamManager.init(memDb, null);
    }
  });

  it('does not burn the whole window on a heartbeat whose write failed', async () => {
    // The latency connection gives up on a contended lock in a few hundred
    // milliseconds. With the window opening on the attempt, only a handful of
    // heartbeats fitted inside the inactivity timeout — lose them all and
    // another worker's sweep reaps a session that is still playing.
    await streamManager.add('s5', user, 'Channel', '10.0.0.5', null, 1, { dedupe: false });
    const afterAdd = lastActivity('s5');

    const original = streamManager.stmtTouch;
    streamManager.stmtTouch = { run: () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e; } };
    try {
      await streamManager.touch('s5', { force: true });
    } finally {
      streamManager.stmtTouch = original;
    }

    // The next attempt comes back long before the window is over.
    await streamManager.touch('s5');
    expect(lastActivity('s5')).toBe(afterAdd);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 4000));
    await streamManager.touch('s5');
    vi.useRealTimers();
    expect(lastActivity('s5')).toBeGreaterThan(afterAdd);
  });

  it('forgets a session so a reused id is not silently throttled', async () => {
    await streamManager.add('s4', user, 'Channel', '10.0.0.4', null, 1, { dedupe: false });
    await streamManager.touch('s4', { force: true });
    expect(streamManager.lastTouchAt.has('s4')).toBe(true);

    await streamManager.remove('s4');
    // The entry has to go with the session: an id that comes back would
    // otherwise start inside the throttle window of its predecessor.
    expect(streamManager.lastTouchAt.has('s4')).toBe(false);

    // add() seeds the entry again for the new session, from its own write.
    await streamManager.add('s4', user, 'Channel', '10.0.0.4', null, 1, { dedupe: false });
    expect(streamManager.lastTouchAt.get('s4')).toBeGreaterThanOrEqual(lastActivity('s4'));
  });
});
