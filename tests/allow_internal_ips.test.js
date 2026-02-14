import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { isSafeIP } from '../src/utils/helpers.js';

describe('isSafeIP Whitelist Tests', () => {
  const originalEnv = process.env.ALLOWED_INTERNAL_IPS;

  beforeEach(() => {
    delete process.env.ALLOWED_INTERNAL_IPS;
  });

  afterEach(() => {
    if (originalEnv) process.env.ALLOWED_INTERNAL_IPS = originalEnv;
    else delete process.env.ALLOWED_INTERNAL_IPS;
  });

  it('should block 127.0.0.1 by default', () => {
    assert.strictEqual(isSafeIP('127.0.0.1'), false);
  });

  it('should allow 127.0.0.1 if whitelisted explicitly', () => {
    process.env.ALLOWED_INTERNAL_IPS = '127.0.0.1';
    assert.strictEqual(isSafeIP('127.0.0.1'), true);
  });

  it('should allow 127.0.0.1 if whitelisted via CIDR', () => {
    process.env.ALLOWED_INTERNAL_IPS = '127.0.0.0/8';
    assert.strictEqual(isSafeIP('127.0.0.1'), true);
  });

  it('should handle multiple IPs and whitespace', () => {
    process.env.ALLOWED_INTERNAL_IPS = ' 192.168.1.5 , 10.0.0.0/24 ';
    assert.strictEqual(isSafeIP('192.168.1.5'), true);
    assert.strictEqual(isSafeIP('10.0.0.5'), true);
    assert.strictEqual(isSafeIP('10.0.1.5'), false); // Outside /24
    assert.strictEqual(isSafeIP('192.168.1.6'), false);
  });
});
