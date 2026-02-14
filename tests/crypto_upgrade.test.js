
import { encrypt, decrypt, ENCRYPTION_KEY } from '../src/utils/crypto.js';
import crypto from 'crypto';
import assert from 'assert';

console.log('🧪 Starting Crypto Upgrade Tests...');

// Helper to create legacy CBC ciphertext
function legacyEncrypt(text, keyHex) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// 1. Verify New Encryption Format (GCM)
console.log('1. Testing New Encryption (GCM)...');
const plaintext = 'This is a secure message';
const encrypted = encrypt(plaintext);
console.log('   Encrypted:', encrypted);

const parts = encrypted.split(':');
if (parts.length !== 3) {
    console.error('❌ FAILED: Expected 3 parts (IV:Ciphertext:Tag), got ' + parts.length);
    process.exit(1);
} else {
    console.log('✅ Format correct (3 parts)');
}

// 2. Verify Decryption of New Format
console.log('2. Testing Decryption of New Format...');
const decrypted = decrypt(encrypted);
if (decrypted !== plaintext) {
    console.error(`❌ FAILED: Decrypted '${decrypted}' does not match '${plaintext}'`);
    process.exit(1);
} else {
    console.log('✅ Decryption successful');
}

// 3. Verify Backward Compatibility (Legacy CBC)
console.log('3. Testing Backward Compatibility (CBC)...');
const legacyPlaintext = 'This is a legacy message';
const legacyCiphertext = legacyEncrypt(legacyPlaintext, ENCRYPTION_KEY);
console.log('   Legacy Ciphertext:', legacyCiphertext);

const legacyParts = legacyCiphertext.split(':');
if (legacyParts.length !== 2) {
    console.error('❌ SETUP ERROR: Legacy helper produced wrong format');
    process.exit(1);
}

const decryptedLegacy = decrypt(legacyCiphertext);
if (decryptedLegacy !== legacyPlaintext) {
    console.error(`❌ FAILED: Legacy decryption failed. Got '${decryptedLegacy}', expected '${legacyPlaintext}'`);
    process.exit(1);
} else {
    console.log('✅ Legacy decryption successful');
}

// 4. Verify Integrity Check (Tampering)
console.log('4. Testing Integrity Check (Tampering)...');

// 4a. Tamper Ciphertext
const tamperedParts1 = [...parts];
const ct = Buffer.from(tamperedParts1[1], 'hex');
ct[0] = ct[0] ^ 0xFF; // Flip first byte
tamperedParts1[1] = ct.toString('hex');
const tamperedCiphertext = tamperedParts1.join(':');

const decryptedTampered1 = decrypt(tamperedCiphertext);
if (decryptedTampered1 !== null) {
    console.error('❌ FAILED: Tampered ciphertext should return null, got:', decryptedTampered1);
    process.exit(1);
} else {
    console.log('✅ Tampered ciphertext rejected (returns null)');
}

// 4b. Tamper Tag
const tamperedParts2 = [...parts];
const tag = Buffer.from(tamperedParts2[2], 'hex');
tag[0] = tag[0] ^ 0xFF; // Flip first byte
tamperedParts2[2] = tag.toString('hex');
const tamperedTag = tamperedParts2.join(':');

const decryptedTampered2 = decrypt(tamperedTag);
if (decryptedTampered2 !== null) {
    console.error('❌ FAILED: Tampered tag should return null, got:', decryptedTampered2);
    process.exit(1);
} else {
    console.log('✅ Tampered tag rejected (returns null)');
}

console.log('🎉 All Crypto Upgrade Tests Passed!');
