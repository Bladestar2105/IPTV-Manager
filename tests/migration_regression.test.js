import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import db, { initDb } from '../src/database/db.js';
import { encrypt, decrypt } from '../src/utils/crypto.js';
import { migrateProviderPasswords, migrateOtpSecrets } from '../src/database/migrations.js';

describe('Migration Bug Regression', () => {
    beforeAll(() => {
        initDb(true);
        db.prepare('DELETE FROM providers').run();
        db.prepare('DELETE FROM users').run();
    });

    it('should NOT re-encrypt GCM passwords', () => {
        const password = 'mysecretpassword';
        const encrypted = encrypt(password); // GCM format

        // Insert GCM encrypted password
        const info = db.prepare('INSERT INTO providers (name, url, username, password) VALUES (?, ?, ?, ?)').run('Test', 'http://x', 'u', encrypted);
        const id = info.lastInsertRowid;

        // Run migration
        migrateProviderPasswords(db);

        // Fetch back
        const row = db.prepare('SELECT password FROM providers WHERE id = ?').get(id);
        const decryptedOnce = decrypt(row.password);
        expect(decryptedOnce).toBe(password);
    });

    it('should NOT re-encrypt GCM OTP secrets', () => {
        const secret = 'myotpsecret';
        const encrypted = encrypt(secret);

        // Insert GCM encrypted OTP secret
        const info = db.prepare('INSERT INTO users (username, password, otp_secret) VALUES (?, ?, ?)').run('otpuser', 'pass', encrypted);
        const id = info.lastInsertRowid;

        // Run migration
        migrateOtpSecrets(db);

        // Fetch back
        const row = db.prepare('SELECT otp_secret FROM users WHERE id = ?').get(id);
        const decryptedOnce = decrypt(row.otp_secret);
        expect(decryptedOnce).toBe(secret);
    });
});
