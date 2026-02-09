import { encrypt } from '../src/utils/crypto.js';
import crypto from 'crypto';

// Mock crypto.createCipheriv to throw an error
const originalCreateCipheriv = crypto.createCipheriv;
crypto.createCipheriv = () => {
  throw new Error('Mocked encryption failure');
};

console.log('--- Testing encrypt() failure mode ---');
const secret = 'super_secret_data';
let result;

try {
  result = encrypt(secret);
} catch (e) {
  if (e.message === 'Encryption failed') {
    console.log('✅ Secure: encrypt() threw an error as expected.');
    process.exit(0);
  } else {
    console.log(`❌ FAILED: encrypt() threw an unexpected error: ${e.message}`);
    process.exit(1);
  }
}

console.log(`Input: ${secret}`);
console.log(`Result: ${result}`);

if (result === secret) {
  console.log('❌ VULNERABILITY DETECTED: encrypt() returned plaintext on failure!');
  process.exit(1);
} else {
  console.log('❌ FAILED: encrypt() returned something but did not throw!');
  process.exit(1);
}
