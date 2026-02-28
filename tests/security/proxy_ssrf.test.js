import { describe, it, expect, vi, afterEach } from 'vitest';
import dns from 'dns';
import { safeLookup, isUnsafeIP } from '../../src/utils/helpers.js';

// Mock dns module
vi.mock('dns', () => {
  return {
    default: {
      lookup: vi.fn(),
      promises: {
        lookup: vi.fn()
      }
    },
    lookup: vi.fn() // For named import usage if any, or default.lookup
  };
});

describe('SSRF Protection', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('isUnsafeIP', () => {
    it('should identify unsafe IP ranges (Loopback, Link-Local)', () => {
      expect(isUnsafeIP('127.0.0.1')).toBe(true);
      expect(isUnsafeIP('169.254.0.1')).toBe(true);
      expect(isUnsafeIP('0.0.0.0')).toBe(true);
      expect(isUnsafeIP('::1')).toBe(true);
      expect(isUnsafeIP('fe80::1')).toBe(true);
      expect(isUnsafeIP('::ffff:127.0.0.1')).toBe(true);
    });

    it('should block private LAN IPs (RFC1918)', () => {
      expect(isUnsafeIP('10.0.0.5')).toBe(true);
      expect(isUnsafeIP('172.16.0.1')).toBe(true);
      expect(isUnsafeIP('192.168.1.1')).toBe(true);
      expect(isUnsafeIP('100.64.0.1')).toBe(true); // CGNAT
    });

    it('should allow public IPs', () => {
      expect(isUnsafeIP('8.8.8.8')).toBe(false);
      expect(isUnsafeIP('1.1.1.1')).toBe(false);
      expect(isUnsafeIP('2606:4700:4700::1111')).toBe(false);
    });
  });

  describe('safeLookup', () => {
    it('should return address for public IP', () => new Promise(done => {
      dns.lookup.mockImplementation((hostname, options, callback) => {
        callback(null, '8.8.8.8', 4);
      });

      safeLookup('google.com', {}, (err, address, family) => {
        expect(err).toBeNull();
        expect(address).toBe('8.8.8.8');
        done();
      });
    }));

    it('should error for private LAN IP', () => new Promise(done => {
      dns.lookup.mockImplementation((hostname, options, callback) => {
        callback(null, '192.168.1.50', 4);
      });

      safeLookup('nas.local', {}, (err, address, family) => {
        expect(err).toBeDefined();
        expect(err.message).toContain('unsafe IP');
        done();
      });
    }));

    it('should error for unsafe IP (Loopback)', () => new Promise(done => {
      dns.lookup.mockImplementation((hostname, options, callback) => {
        callback(null, '127.0.0.1', 4);
      });

      safeLookup('localhost', {}, (err, address, family) => {
        expect(err).toBeDefined();
        expect(err.message).toContain('unsafe IP');
        done();
      });
    }));

    it('should handle DNS errors', () => new Promise(done => {
       const dnsError = new Error('ENOTFOUND');
       dns.lookup.mockImplementation((hostname, options, callback) => {
        callback(dnsError);
      });

      safeLookup('invalid.domain', {}, (err) => {
        expect(err).toBe(dnsError);
        done();
      });
    }));
  });
});
