
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';

const TEST_DIR = path.join(process.cwd(), 'test_data_timing_vitest');

// Ensure dir exists and set env var
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DIR;

describe('Timing Attack Mitigation', async () => {
    let authService;
    let db;
    let BCRYPT_ROUNDS;

    beforeAll(async () => {
        // Dynamic imports to pick up env var
        const dbModule = await import('../../src/database/db.js');
        db = dbModule.default;
        dbModule.initDb(true);

        const authServiceModule = await import('../../src/services/authService.js');
        authService = authServiceModule;

        const constants = await import('../../src/config/constants.js');
        BCRYPT_ROUNDS = constants.BCRYPT_ROUNDS;

        // Create a test user
        const hash = await bcrypt.hash('password123', BCRYPT_ROUNDS);
        db.prepare('DELETE FROM users WHERE username = ?').run('timing_user');
        db.prepare('INSERT INTO users (username, password, is_active) VALUES (?, ?, 1)').run('timing_user', hash);
    });

    afterAll(() => {
        // Cleanup
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (e) {}
    });

    it('should have consistent timing for valid and invalid users', async () => {
        // Warmup to load modules and cache
        await authService.authUser('timing_user', 'password123');

        // Measure time for Invalid User (should be slow after fix)
        // We run multiple times to average out jitter
        let totalInvalid = 0;
        const iterations = 5;
        for(let i=0; i<iterations; i++) {
            const start = performance.now();
            await authService.authUser('invalid_user_xyz', 'password123');
            totalInvalid += (performance.now() - start);
        }
        const avgInvalid = totalInvalid / iterations;

        // Measure time for Valid User with Wrong Password (reference slow operation)
        let totalValid = 0;
        for(let i=0; i<iterations; i++) {
            const start = performance.now();
            await authService.authUser('timing_user', 'wrong_password');
            totalValid += (performance.now() - start);
        }
        const avgValid = totalValid / iterations;

        console.log(`Avg Invalid User Duration: ${avgInvalid.toFixed(2)}ms`);
        console.log(`Avg Valid User (Wrong Pass) Duration: ${avgValid.toFixed(2)}ms`);

        // Assertions
        // Without fix: Invalid is ~0.2ms, Valid is ~100ms. Ratio ~0.002
        // With fix: Invalid is ~100ms, Valid is ~100ms. Ratio ~1.0

        const ratio = avgInvalid / avgValid;
        console.log(`Timing Ratio: ${ratio.toFixed(4)}`);

        // We expect the ratio to be significant. If it's too small, vulnerability exists.
        // Using 0.5 as a very safe threshold (meaning invalid user takes at least half as long as valid user)
        expect(ratio).toBeGreaterThan(0.5);
    }, 20000);
});
