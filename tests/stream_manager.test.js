
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import streamManager from '../src/services/streamManager.js';

describe('StreamManager (SQLite)', () => {
    let db;

    beforeAll(() => {
        db = new Database(':memory:');

        // Setup Schema
        db.exec(`
          CREATE TABLE IF NOT EXISTS current_streams (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            username TEXT,
            channel_name TEXT,
            start_time INTEGER,
            last_activity INTEGER,
            ip TEXT,
            worker_pid INTEGER,
            provider_id INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_cs_user_ip ON current_streams(user_id, ip);
        `);

        // Initialize StreamManager
        streamManager.init(db, null);
    });

    afterEach(() => {
        // Clear table after each test
        db.exec('DELETE FROM current_streams');
        streamManager.localStreams.clear();
    });

    it('should add a stream correctly', async () => {
        const user = { id: 1, username: 'testuser' };
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1', null, 1);

        const streams = await streamManager.getAll();
        expect(streams).toHaveLength(1);
        expect(streams[0].id).toBe('stream1');
        expect(streams[0].username).toBe('testuser');
    });

    it('should cleanup user streams correctly', async () => {
        const user = { id: 1, username: 'testuser' };

        // Add stream
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1', null, 1);

        // Verify added
        let streams = await streamManager.getAll();
        expect(streams).toHaveLength(1);

        // Cleanup
        await streamManager.cleanupUser(1, '127.0.0.1');

        streams = await streamManager.getAll();
        expect(streams).toHaveLength(0);
    });

    it('should remove a stream correctly', async () => {
        const user = { id: 1, username: 'testuser' };
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1', null, 1);

        await streamManager.remove('stream1');

        const streams = await streamManager.getAll();
        expect(streams).toHaveLength(0);
    });

    it('should handle multiple streams', async () => {
         const user = { id: 1, username: 'testuser' };
         await streamManager.add('s1', user, 'C1', '127.0.0.1', null, 1);
         await streamManager.add('s2', user, 'C2', '127.0.0.2', null, 1);

         const streams = await streamManager.getAll();
         expect(streams).toHaveLength(2);
    });


    it('should keep active sessions countable even when start_time is old', async () => {
        const now = Date.now();
        db.prepare(`
          INSERT INTO current_streams (id, user_id, username, channel_name, start_time, last_activity, ip, worker_pid, provider_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('old-but-active', 2, 'activeuser', 'Live C', now - (26 * 60 * 60 * 1000), now - 1000, '127.0.0.8', 999999, 2);

        const count = await streamManager.getUserConnectionCount(2);
        expect(count).toBe(1);

        const streams = await streamManager.getAll();
        expect(streams.map(s => s.id)).toContain('old-but-active');
    });

    it('should cleanup streams from dead workers before counting limits', async () => {
        const user = { id: 1, username: 'testuser' };
        await streamManager.add('active-stream', user, 'C1', '127.0.0.1', null, 1);

        db.prepare(`
          INSERT INTO current_streams (id, user_id, username, channel_name, start_time, last_activity, ip, worker_pid, provider_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('stale-stream', 1, 'testuser', 'Old C', Date.now() - 10000, Date.now() - 10000, '127.0.0.1', 999999, 1);

        const count = await streamManager.getUserConnectionCount(1);
        expect(count).toBe(1);

        const streams = await streamManager.getAll();
        expect(streams.map(s => s.id)).toEqual(['active-stream']);
    });
});
