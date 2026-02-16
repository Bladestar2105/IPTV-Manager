import { describe, it, expect, vi, beforeAll } from 'vitest';
import { authenticateToken } from '../../src/middleware/auth.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../src/utils/crypto.js';
import db, { initDb } from '../../src/database/db.js';

describe('Proxy Authentication', () => {
    beforeAll(() => {
        initDb(true);
        db.prepare("INSERT OR IGNORE INTO admin_users (id, username, password) VALUES (1, 'admin', 'adminpass')").run();
    });

    it('should authenticate with token in query param', () => {
        const token = jwt.sign({ id: 1, is_admin: true }, JWT_SECRET);
        const req = {
            headers: {},
            query: { token: token }
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };
        const next = vi.fn();

        authenticateToken(req, res, next);

        expect(next).toHaveBeenCalled();
    });

    it('should fail without token', () => {
        const req = {
            headers: {},
            query: {}
        };
        const res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn()
        };
        const next = vi.fn();

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});
