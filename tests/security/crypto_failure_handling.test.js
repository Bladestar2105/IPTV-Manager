import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { encrypt } from '../../src/utils/crypto.js';

describe('Crypto Failure Handling', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should throw "Encryption failed" when crypto throws', () => {
        // Mock createCipheriv to throw an error
        vi.spyOn(crypto, 'createCipheriv').mockImplementation(() => {
            throw new Error('Mocked encryption failure');
        });
        // Silence console.error since the function logs it
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const secret = 'super_secret_data';

        expect(() => {
            encrypt(secret);
        }).toThrow('Encryption failed');
    });

    it('should not return plaintext on failure', () => {
        // Mock createCipheriv to throw an error
        vi.spyOn(crypto, 'createCipheriv').mockImplementation(() => {
            throw new Error('Mocked encryption failure');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        const secret = 'super_secret_data';
        let result = null;

        try {
            result = encrypt(secret);
        } catch (e) {
            // Expected
        }

        expect(result).toBeNull();
        expect(result).not.toBe(secret);
    });
});
