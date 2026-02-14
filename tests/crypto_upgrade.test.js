
import { encrypt, decrypt, ENCRYPTION_KEY } from '../src/utils/crypto.js';
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';

describe('Crypto Upgrade Tests', () => {

// Helper to create legacy CBC ciphertext
function legacyEncrypt(text, keyHex) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// 1. Verify New Encryption Format (GCM)
it('Testing New Encryption (GCM)...', () => {
    const plaintext = 'This is a secure message';
    const encrypted = encrypt(plaintext);
    console.log('   Encrypted:', encrypted);

    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    console.log('✅ Format correct (3 parts)');
});

// 2. Verify Decryption of New Format
it('Testing Decryption of New Format...', () => {
    const plaintext = 'This is a secure message';
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
    console.log('✅ Decryption successful');
});

// 3. Verify Backward Compatibility (Legacy CBC)
it('Testing Backward Compatibility (CBC)...', () => {
    const legacyPlaintext = 'This is a legacy message';
    const legacyCiphertext = legacyEncrypt(legacyPlaintext, ENCRYPTION_KEY);
    console.log('   Legacy Ciphertext:', legacyCiphertext);

    const legacyParts = legacyCiphertext.split(':');
    expect(legacyParts.length).toBe(2);

    const decryptedLegacy = decrypt(legacyCiphertext);
    expect(decryptedLegacy).toBe(legacyPlaintext);
    console.log('✅ Legacy decryption successful');
});

// 4. Verify Integrity Check (Tampering)
it('Testing Integrity Check (Tampering)...', () => {
    const plaintext = 'This is a secure message';
    const encrypted = encrypt(plaintext);
    const parts = encrypted.split(':');

    // 4a. Tamper Ciphertext
    const tamperedParts1 = [...parts];
    const ct = Buffer.from(tamperedParts1[1], 'hex');
    ct[0] = ct[0] ^ 0xFF; // Flip first byte
    tamperedParts1[1] = ct.toString('hex');
    const tamperedCiphertext = tamperedParts1.join(':');

    const decryptedTampered1 = decrypt(tamperedCiphertext);
    expect(decryptedTampered1).toBe(null);
    console.log('✅ Tampered ciphertext rejected (returns null)');

    // 4b. Tamper Tag
    const tamperedParts2 = [...parts];
    const tag = Buffer.from(tamperedParts2[2], 'hex');
    tag[0] = tag[0] ^ 0xFF; // Flip first byte
    tamperedParts2[2] = tag.toString('hex');
    const tamperedTag = tamperedParts2.join(':');

    const decryptedTampered2 = decrypt(tamperedTag);
    expect(decryptedTampered2).toBe(null);
    console.log('✅ Tampered tag rejected (returns null)');
});

});
