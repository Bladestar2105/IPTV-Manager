import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

// The stream budgets were the last settings still parsed by hand, with
// `Number(process.env.X || default)`. A value carrying a unit — the shape
// operators keep writing, and the shape that already cost every EPG import a
// second in — is NaN there, and every comparison against NaN is false: the
// inactivity sweep switches itself off and, worse, the activity throttle stops
// throttling, so every ffmpeg progress event becomes an UPDATE on the shared
// database again. That write amplification is the contention this change set
// exists to remove.

const databases = [];
const openDb = () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE current_streams (
    id TEXT PRIMARY KEY, user_id INTEGER, username TEXT, channel_name TEXT,
    start_time INTEGER, last_activity INTEGER, ip TEXT, worker_pid INTEGER, provider_id INTEGER
  );`);
  databases.push(db);
  return db;
};

/** A fresh module instance — the budgets are read once, at import time. */
const loadWith = async env => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import('../src/services/streamManager.js')).default;
};

const user = { id: 1, username: 'u' };

/**
 * Count the heartbeat UPDATEs, installed before init() prepares them.
 *
 * Comparing last_activity before and after cannot see this: every touch in a
 * burst writes Date.now(), and a burst fits inside one millisecond, so an
 * unthrottled run writes 25 times and leaves the column looking untouched.
 */
const countTouchWrites = db => {
  const counts = { writes: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!/UPDATE current_streams SET last_activity/i.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'run') return (...args) => { counts.writes++; return target.run(...args); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return counts;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  while (databases.length) databases.pop().close();
});

describe('stream budgets from the environment', () => {
  it('keeps throttling when the timeout is given with a unit', async () => {
    const db = openDb();
    const counts = countTouchWrites(db);
    const manager = await loadWith({ STREAM_INACTIVITY_TIMEOUT_MS: '5m' });
    manager.init(db, null);

    await manager.add('s1', user, 'Channel', '10.0.0.1', null, 1, { dedupe: false });
    for (let i = 0; i < 25; i++) await manager.touch('s1');

    // add() opens the window, so a throttled burst writes nothing at all;
    // with a NaN window every one of the 25 is its own UPDATE.
    expect(counts.writes).toBe(0);
  });

  it('still reaps an idle session when the timeout is given with a unit', async () => {
    const manager = await loadWith({ STREAM_INACTIVITY_TIMEOUT_MS: '5m' });
    manager.init(openDb(), null);

    const now = Date.now();
    expect(manager.isStale({ id: 'x', worker_pid: process.pid, start_time: now - 600000, last_activity: now - 600000 }, now))
      .toBe(true);
  });

  it('still enforces the age cap when it is given with a unit', async () => {
    // Inactivity is switched off here so only the age cap can answer.
    const manager = await loadWith({ STREAM_MAX_AGE_MS: '24h', STREAM_INACTIVITY_TIMEOUT_MS: '0' });
    manager.init(openDb(), null);

    const now = Date.now();
    const base = { id: 'x', worker_pid: process.pid, last_activity: now - 1000 };
    expect(manager.isStale({ ...base, start_time: now - 25 * 3600000 }, now)).toBe(true);
    expect(manager.isStale({ ...base, start_time: now - 60000 }, now)).toBe(false);
  });

  it('keeps 0 as the documented way to switch the inactivity sweep off', async () => {
    // resolveBudget refuses 0 everywhere else; here it is a real setting, read
    // by the guard in isStale(), and a long recording depends on it.
    const manager = await loadWith({ STREAM_INACTIVITY_TIMEOUT_MS: '0' });
    manager.init(openDb(), null);

    const now = Date.now();
    const ancient = { id: 'x', worker_pid: process.pid, start_time: now - 3600000, last_activity: now - 3600000 };
    expect(manager.isStale(ancient, now)).toBe(false);
    // The age cap still applies, and the throttle still has a floor.
    expect(manager.isStale({ ...ancient, start_time: now - 25 * 3600000 }, now)).toBe(true);
  });
});
