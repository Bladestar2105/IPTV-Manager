
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import db from '../src/database/db.js';
import { authenticateToken } from '../src/middleware/auth.js';

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
    default: {
        verify: vi.fn(),
    },
}));

// Mock database
vi.mock('../src/database/db.js', () => ({
    default: {
        prepare: vi.fn(),
    },
}));

// Mock crypto utils to avoid importing dotenv via constants.js
vi.mock('../src/utils/crypto.js', () => ({
    JWT_SECRET: 'test-secret',
}));

describe('Auth Middleware - authenticateToken', () => {
    let req, res, next;

    beforeEach(() => {
        req = {
            headers: {},
            query: {},
        };
        res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn(),
        };
        next = vi.fn();
        vi.clearAllMocks();
    });

    it('should return 401 if no token is provided', () => {
        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should extract token from Authorization header', () => {
        req.headers['authorization'] = 'Bearer valid-token';

        // Mock verify to succeed immediately
        jwt.verify.mockImplementation((token, secret, cb) => {
             cb(null, { id: 1, is_admin: false });
        });

        // Mock DB to prevent crash
        db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ id: 1, is_active: 1, webui_access: 1 }) });

        authenticateToken(req, res, next);

        expect(jwt.verify).toHaveBeenCalledWith('valid-token', 'test-secret', expect.any(Function));
    });

    it('should extract token from query parameter', () => {
        req.query.token = 'valid-query-token';

        // Mock verify to succeed immediately
        jwt.verify.mockImplementation((token, secret, cb) => {
             cb(null, { id: 1, is_admin: false });
        });

        // Mock DB to prevent crash
        db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ id: 1, is_active: 1, webui_access: 1 }) });

        authenticateToken(req, res, next);

        expect(jwt.verify).toHaveBeenCalledWith('valid-query-token', 'test-secret', expect.any(Function));
    });

    it('should return 403 if token is invalid or expired', () => {
        req.headers['authorization'] = 'Bearer invalid-token';

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(new Error('Invalid token'), null);
        });

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should authenticate a valid admin user', () => {
        req.headers['authorization'] = 'Bearer admin-token';

        const userPayload = { id: 1, is_admin: true };
        const dbUser = { id: 1, username: 'admin', is_active: 1, otp_enabled: 1 };

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, userPayload);
        });

        const getMock = vi.fn().mockReturnValue(dbUser);
        db.prepare.mockReturnValue({ get: getMock });

        authenticateToken(req, res, next);

        // Verify DB call
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM admin_users'));
        expect(getMock).toHaveBeenCalledWith(1);

        // Verify req.user update
        expect(req.user).toEqual({
            id: 1,
            username: 'admin',
            is_active: 1,
            is_admin: true,
            otp_enabled: true
        });

        expect(next).toHaveBeenCalled();
    });

    it('should authenticate a valid regular user with webui access', () => {
        req.headers['authorization'] = 'Bearer user-token';

        const userPayload = { id: 2, is_admin: false };
        const dbUser = { id: 2, username: 'user', is_active: 1, webui_access: 1, otp_enabled: 0 };

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, userPayload);
        });

        const getMock = vi.fn().mockReturnValue(dbUser);
        db.prepare.mockReturnValue({ get: getMock });

        authenticateToken(req, res, next);

        // Verify DB call
        expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM users'));
        expect(getMock).toHaveBeenCalledWith(2);

        // Verify req.user update
        expect(req.user).toEqual({
            id: 2,
            username: 'user',
            is_active: 1,
            is_admin: false,
            otp_enabled: false
        });

        expect(next).toHaveBeenCalled();
    });

    it('should return 401 if user is not found in database', () => {
        req.headers['authorization'] = 'Bearer valid-token';

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, { id: 99, is_admin: false });
        });

        db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) });

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'User is inactive or deleted' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 if user is inactive', () => {
        req.headers['authorization'] = 'Bearer valid-token';

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, { id: 2, is_admin: false });
        });

        db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ id: 2, is_active: 0 }) });

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: 'User is inactive or deleted' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 if regular user has no webui access', () => {
        req.headers['authorization'] = 'Bearer valid-token';

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, { id: 2, is_admin: false });
        });

        // webui_access: 0
        db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ id: 2, is_active: 1, webui_access: 0 }) });

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'WebUI access revoked' });
        expect(next).not.toHaveBeenCalled();
    });

    it('should return 500 if database query fails', () => {
        req.headers['authorization'] = 'Bearer valid-token';

        jwt.verify.mockImplementation((token, secret, cb) => {
            cb(null, { id: 1, is_admin: true });
        });

        db.prepare.mockImplementation(() => {
            throw new Error('Database connection failed');
        });

        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        authenticateToken(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
        expect(next).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalled();

        consoleSpy.mockRestore();
    });
});
