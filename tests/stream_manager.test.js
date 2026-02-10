
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import streamManager from '../src/stream_manager.js';

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
            ip TEXT,
            worker_pid INTEGER
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
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1');

        const streams = await streamManager.getAll();
        expect(streams).toHaveLength(1);
        expect(streams[0].id).toBe('stream1');
        expect(streams[0].username).toBe('testuser');
    });

    it('should cleanup user streams correctly', async () => {
        const user = { id: 1, username: 'testuser' };

        // Add stream
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1');

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
        await streamManager.add('stream1', user, 'Test Channel', '127.0.0.1');

        await streamManager.remove('stream1');

        const streams = await streamManager.getAll();
        expect(streams).toHaveLength(0);
    });

    it('should handle multiple streams', async () => {
         const user = { id: 1, username: 'testuser' };
         await streamManager.add('s1', user, 'C1', '127.0.0.1');
         await streamManager.add('s2', user, 'C2', '127.0.0.2');

         const streams = await streamManager.getAll();
         expect(streams).toHaveLength(2);
    });
});
