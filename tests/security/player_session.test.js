import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import db, { initDb } from '../../src/database/db.js';
import { createPlayerToken } from '../../src/controllers/authController.js';
import { getXtreamUser } from '../../src/services/authService.js';

describe('Player Session Security', () => {
    beforeAll(() => {
        initDb(true);
        // Clean up dependent tables first
        db.prepare('DELETE FROM temporary_tokens').run();
        db.prepare('DELETE FROM users').run();

        // Create user
        db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('testuser', 'password');
    });

    afterAll(() => {
        // Cleanup to avoid polluting other tests
        db.prepare('DELETE FROM temporary_tokens').run();
        db.prepare('DELETE FROM users').run();
    });

    it('should generate a player token with a session cookie', () => {
        const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser').id;
        const req = {
            body: { user_id: userId },
            user: { is_admin: true, id: 999, username: 'admin' }
        };
        const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis(),
            cookie: vi.fn()
        };

        createPlayerToken(req, res);

        expect(res.json).toHaveBeenCalled();
        const responseData = res.json.mock.calls[0][0];
        expect(responseData).toHaveProperty('token');

        expect(res.cookie).toHaveBeenCalled();
        const cookieArgs = res.cookie.mock.calls[0];
        expect(cookieArgs[0]).toBe('player_session');
        expect(cookieArgs[2]).toHaveProperty('httpOnly', true);
        expect(cookieArgs[2]).toHaveProperty('sameSite', 'strict');

        const token = responseData.token;
        const sessionId = cookieArgs[1];

        // Verify DB
        const dbToken = db.prepare('SELECT * FROM temporary_tokens WHERE token = ?').get(token);
        expect(dbToken).toBeDefined();
        expect(dbToken.session_id).toBe(sessionId);
    });

    it('should authenticate with valid token and matching cookie', async () => {
        const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser').id;
        // Create token manually to know values
        const token = 'valid-token';
        const sessionId = 'valid-session-id';
        const now = Math.floor(Date.now() / 1000);
        db.prepare('DELETE FROM temporary_tokens').run();
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at, session_id) VALUES (?, ?, ?, ?)')
          .run(token, userId, now + 3600, sessionId);

        const req = {
            query: { token },
            headers: {
                cookie: `player_session=${sessionId}`
            },
            params: {}
        };

        const user = await getXtreamUser(req);
        expect(user).toBeDefined();
        expect(user.id).toBe(userId);
    });

    it('should fail authentication with valid token but missing cookie', async () => {
        const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser').id;
        const token = 'missing-cookie-token';
        const sessionId = 'session-id-2';
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at, session_id) VALUES (?, ?, ?, ?)')
          .run(token, userId, now + 3600, sessionId);

        const req = {
            query: { token },
            headers: {}, // No cookie
            params: {}
        };

        const user = await getXtreamUser(req);
        expect(user).toBeNull();
    });

    it('should fail authentication with valid token but wrong cookie', async () => {
        const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser').id;
        const token = 'wrong-cookie-token';
        const sessionId = 'session-id-3';
        const now = Math.floor(Date.now() / 1000);
        db.prepare('INSERT INTO temporary_tokens (token, user_id, expires_at, session_id) VALUES (?, ?, ?, ?)')
          .run(token, userId, now + 3600, sessionId);

        const req = {
            query: { token },
            headers: {
                cookie: `player_session=wrong-session-id`
            },
            params: {}
        };

        const user = await getXtreamUser(req);
        expect(user).toBeNull();
    });
});
