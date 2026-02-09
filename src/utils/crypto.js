import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/constants.js';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  const jwtFile = path.join(DATA_DIR, 'jwt.secret');
  if (fs.existsSync(jwtFile)) {
    JWT_SECRET = fs.readFileSync(jwtFile, 'utf8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(jwtFile, JWT_SECRET, { mode: 0o600 });
    console.log('🔐 Generated new unique JWT secret and saved to jwt.secret');
  }
}

let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyFile)) {
    ENCRYPTION_KEY = fs.readFileSync(keyFile, 'utf8').trim();
  } else {
    ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, ENCRYPTION_KEY, { mode: 0o600 });
    console.log('🔐 Generated new unique encryption key and saved to secret.key');
  }
}
// Ensure key is 32 bytes for AES-256
if (Buffer.from(ENCRYPTION_KEY, 'hex').length !== 32) {
  ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest('hex');
}

export { JWT_SECRET, ENCRYPTION_KEY };

export function encrypt(text) {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (e) {
    console.error('Encryption error:', e);
    throw new Error('Encryption failed');
  }
}

export function decrypt(text) {
  if (!text) return text;
  try {
    const textParts = text.split(':');
    if (textParts.length !== 2) return null;
    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return null;
  }
}

export function encryptWithPassword(dataBuffer, password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: Salt(16) + IV(12) + Tag(16) + EncryptedData
  return Buffer.concat([salt, iv, tag, encrypted]);
}

export function decryptWithPassword(encryptedBuffer, password) {
  const salt = encryptedBuffer.subarray(0, 16);
  const iv = encryptedBuffer.subarray(16, 28);
  const tag = encryptedBuffer.subarray(28, 44);
  const data = encryptedBuffer.subarray(44);

  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}
