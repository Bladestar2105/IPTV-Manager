import { vi } from 'vitest';

export async function decryptClientGrant(url) {
  const { decrypt } = await vi.importActual('../../src/utils/crypto.js');
  const token = new URL(url.split('|')[0]).pathname.split('/')[4];
  const encrypted = token.split('.').map(part => Buffer.from(part, 'base64url').toString('hex')).join(':');
  return JSON.parse(decrypt(encrypted));
}
