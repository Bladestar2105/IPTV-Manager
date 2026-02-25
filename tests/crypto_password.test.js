
import { describe, it, expect } from 'vitest';
import { encryptWithPassword, decryptWithPassword } from '../src/utils/crypto.js';
import crypto from 'node:crypto';

describe('Password-based Encryption Utilities', () => {
  const password = 'strong-test-password';
  const data = Buffer.from('Hello, world! This is a test of system backup encryption.');

  it('should successfully encrypt and decrypt a buffer', () => {
    const encrypted = encryptWithPassword(data, password);
    expect(encrypted).toBeInstanceOf(Buffer);
    expect(encrypted.length).toBeGreaterThan(data.length);

    const decrypted = decryptWithPassword(encrypted, password);
    expect(decrypted).toBeInstanceOf(Buffer);
    expect(decrypted.toString()).toBe(data.toString());
  });

  it('should throw an error when decrypting with the wrong password', () => {
    const encrypted = encryptWithPassword(data, password);
    expect(() => decryptWithPassword(encrypted, 'wrong-password')).toThrow();
  });

  it('should throw an error if the salt is tampered with', () => {
    const encrypted = encryptWithPassword(data, password);
    // Tamper with salt (first 16 bytes)
    encrypted[0] = encrypted[0] ^ 0xFF;
    expect(() => decryptWithPassword(encrypted, password)).toThrow();
  });

  it('should throw an error if the IV is tampered with', () => {
    const encrypted = encryptWithPassword(data, password);
    // Tamper with IV (bytes 16-28)
    encrypted[16] = encrypted[16] ^ 0xFF;
    expect(() => decryptWithPassword(encrypted, password)).toThrow();
  });

  it('should throw an error if the Auth Tag is tampered with', () => {
    const encrypted = encryptWithPassword(data, password);
    // Tamper with tag (bytes 28-44)
    encrypted[28] = encrypted[28] ^ 0xFF;
    expect(() => decryptWithPassword(encrypted, password)).toThrow();
  });

  it('should throw an error if the encrypted data is tampered with', () => {
    const encrypted = encryptWithPassword(data, password);
    // Tamper with data (bytes 44+)
    encrypted[44] = encrypted[44] ^ 0xFF;
    expect(() => decryptWithPassword(encrypted, password)).toThrow();
  });

  it('should handle an empty buffer', () => {
    const emptyData = Buffer.alloc(0);
    const encrypted = encryptWithPassword(emptyData, password);
    const decrypted = decryptWithPassword(encrypted, password);
    expect(decrypted.length).toBe(0);
    expect(decrypted.toString()).toBe('');
  });

  it('should handle a very large buffer', () => {
    const largeData = crypto.randomBytes(1024 * 1024); // 1MB
    const encrypted = encryptWithPassword(largeData, password);
    const decrypted = decryptWithPassword(encrypted, password);
    expect(decrypted.equals(largeData)).toBe(true);
  });

  it('should handle an empty password (not recommended, but should work)', () => {
    const emptyPassword = '';
    const encrypted = encryptWithPassword(data, emptyPassword);
    const decrypted = decryptWithPassword(encrypted, emptyPassword);
    expect(decrypted.toString()).toBe(data.toString());
  });

  it('should handle a long password', () => {
    const longPassword = 'a'.repeat(1000);
    const encrypted = encryptWithPassword(data, longPassword);
    const decrypted = decryptWithPassword(encrypted, longPassword);
    expect(decrypted.toString()).toBe(data.toString());
  });
});
