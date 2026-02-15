import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as authController from '../src/controllers/authController.js';
import db from '../src/database/db.js';
import bcrypt from 'bcrypt';
import { authenticator } from 'otplib';

// Mock dependencies
vi.mock('../src/database/db.js', () => ({
  default: {
    prepare: vi.fn(),
    exec: vi.fn(),
    pragma: vi.fn()
  }
}));

vi.mock('bcrypt', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn()
  }
}));

vi.mock('../src/utils/crypto.js', () => ({
  decrypt: vi.fn((val) => val), // Simple pass-through for test
  encrypt: vi.fn((val) => val),
  generateToken: vi.fn(() => 'mock_token')
}));

vi.mock('../src/services/authService.js', () => ({
  generateToken: vi.fn(() => 'mock_token'),
  preventTimingAttack: vi.fn()
}));

vi.mock('otplib', () => ({
  authenticator: {
    verify: vi.fn(({ token }) => {
      // simulate otplib behavior: fails if token is not a string
      return typeof token === 'string';
    }),
    generateSecret: vi.fn(),
    keyuri: vi.fn()
  }
}));

describe('Auth Controller - OTP Login', () => {
    let req, res;

    beforeEach(() => {
        req = {
            body: {},
            ip: '127.0.0.1'
        };
        res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis(),
        };
        vi.clearAllMocks();
    });

    it('should login successfully when OTP is provided as a number (after fix)', async () => {
        const user = {
            id: 1,
            username: 'admin',
            password: '$2b$10$hash',
            is_active: 1,
            otp_enabled: 1,
            otp_secret: 'secret',
            is_admin: 1
        };

        // Mock DB finding user
        const mockGet = vi.fn().mockReturnValue(user);
        db.prepare.mockReturnValue({ get: mockGet, run: vi.fn() }); // run is for logging

        // Mock password check
        bcrypt.compare.mockResolvedValue(true);

        // Input with number OTP
        req.body = {
            username: 'admin',
            password: 'password',
            otp_code: 123456 // Number!
        };

        await authController.login(req, res);

        // Expectations
        expect(bcrypt.compare).toHaveBeenCalled();

        // This is the key expectation: authenticator.verify should have been called
        // And if the code handles it correctly, it returns success.
        // Since we mocked authenticator.verify to return true ONLY if token is string,
        // success means the controller converted it.

        if (res.json.mock.calls.length > 0) {
             expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                token: 'mock_token'
            }));
        } else {
            // If it failed (401), this will show it
            expect(res.status).not.toHaveBeenCalledWith(401);
        }
    });
});
