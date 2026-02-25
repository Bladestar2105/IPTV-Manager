import { describe, it, expect, vi } from 'vitest';
import { isSafeUrl } from '../../src/utils/helpers.js';

describe('Relaxed isSafeUrl Checks', () => {
  it('should allow non-resolving domains (DNS check skipped)', async () => {
    // previously this would fail if DNS lookup failed
    const safe = await isSafeUrl('http://non-existent-domain.test');
    expect(safe).toBe(true);
  });

  it('should allow domains that resolve to unsafe IPs (DNS check deferred to agent)', async () => {
    // previously this would fail if it resolved to 127.0.0.1
    // now we rely on httpAgent to block it
    const safe = await isSafeUrl('http://local.test');
    expect(safe).toBe(true);
  });

  it('should still block explicit unsafe IPs', async () => {
    expect(await isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(await isSafeUrl('http://0.0.0.0')).toBe(false);
  });

  it('should still block blacklisted hostnames', async () => {
    expect(await isSafeUrl('http://localhost')).toBe(false);
    expect(await isSafeUrl('http://metadata.google.internal')).toBe(false);
  });
});
