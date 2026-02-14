import { describe, it, expect } from 'vitest';
import { isSafeUrl } from '../../src/utils/helpers.js';

describe('isSafeUrl Security Checks', () => {
  it('should block 0.0.0.0 (IPv4 Any)', async () => {
    const safe = await isSafeUrl('http://0.0.0.0');
    expect(safe).toBe(false);
  });

  it('should block :: (IPv6 Any)', async () => {
    const safe = await isSafeUrl('http://[::]');
    expect(safe).toBe(false);
  });

  it('should block 0.0.0.0 with port', async () => {
    const safe = await isSafeUrl('http://0.0.0.0:8080');
    expect(safe).toBe(false);
  });

  it('should block :: with port', async () => {
    const safe = await isSafeUrl('http://[::]:8080');
    expect(safe).toBe(false);
  });

  it('should allow public IPs', async () => {
    const safe = await isSafeUrl('http://8.8.8.8');
    expect(safe).toBe(true);
  });

  it('should block 127.0.0.1', async () => {
    const safe = await isSafeUrl('http://127.0.0.1');
    expect(safe).toBe(false);
  });

  it('should block ::1', async () => {
    const safe = await isSafeUrl('http://[::1]');
    expect(safe).toBe(false);
  });

  it('should block CGNAT range (100.64.0.1)', async () => {
    const safe = await isSafeUrl('http://100.64.0.1');
    expect(safe).toBe(false);
  });

  it('should block TEST-NET-1 (192.0.2.1)', async () => {
    const safe = await isSafeUrl('http://192.0.2.1');
    expect(safe).toBe(false);
  });

  it('should block TEST-NET-2 (198.51.100.1)', async () => {
    const safe = await isSafeUrl('http://198.51.100.1');
    expect(safe).toBe(false);
  });

  it('should block TEST-NET-3 (203.0.113.1)', async () => {
    const safe = await isSafeUrl('http://203.0.113.1');
    expect(safe).toBe(false);
  });

  it('should block Multicast (224.0.0.1)', async () => {
    const safe = await isSafeUrl('http://224.0.0.1');
    expect(safe).toBe(false);
  });

  it('should block Multicast (239.255.255.250)', async () => {
    const safe = await isSafeUrl('http://239.255.255.250');
    expect(safe).toBe(false);
  });

  it('should block Private 172.16.x.x', async () => {
    const safe = await isSafeUrl('http://172.16.0.1');
    expect(safe).toBe(false);
  });

  it('should allow Public 172.32.x.x', async () => {
    const safe = await isSafeUrl('http://172.32.0.1');
    expect(safe).toBe(true);
  });
});
