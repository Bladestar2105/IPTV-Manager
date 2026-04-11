import { describe, it, expect, vi, beforeEach } from 'vitest';
import geoip from 'geoip-lite';
import db from '../../src/database/db.js';
import { isIpAllowedForUser } from '../../src/services/geoIpService.js';

vi.mock('geoip-lite');
vi.mock('../../src/database/db.js', () => ({
  default: {
    prepare: vi.fn()
  }
}));

describe('geoIpService - isIpAllowedForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for DB whitelisted_ips check
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue(null)
    });
  });

  it('should allow if user is null', () => {
    expect(isIpAllowedForUser('1.2.3.4', null)).toBe(true);
  });

  it('should allow if user is admin', () => {
    const user = { is_admin: true };
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
  });

  it('should allow if allowed_countries is null', () => {
    const user = { allowed_countries: null, is_admin: false };
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
  });

  it('should allow if allowed_countries is "null" string', () => {
    const user = { allowed_countries: 'null', is_admin: false };
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
  });

  it('should allow if allowed_countries is "undefined" string', () => {
    const user = { allowed_countries: 'undefined', is_admin: false };
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
  });

  it('should allow if allowed_countries is an empty string', () => {
    const user = { allowed_countries: '', is_admin: false };
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
  });

  it('should allow if IP is whitelisted in database', () => {
    const user = { allowed_countries: 'US', is_admin: false };
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({ 1: 1 })
    });
    expect(isIpAllowedForUser('1.2.3.4', user)).toBe(true);
    expect(db.prepare).toHaveBeenCalledWith('SELECT 1 FROM whitelisted_ips WHERE ip = ?');
  });

  it('should allow local/private IPs (unsafe IPs)', () => {
    const user = { allowed_countries: 'US', is_admin: false };
    expect(isIpAllowedForUser('127.0.0.1', user)).toBe(true);
    expect(isIpAllowedForUser('192.168.1.1', user)).toBe(true);
  });

  it('should allow if geoip lookup fails (fail-open)', () => {
    const user = { allowed_countries: 'US', is_admin: false };
    geoip.lookup.mockReturnValue(null);
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);
  });

  it('should allow if geoip lookup returns no country', () => {
    const user = { allowed_countries: 'US', is_admin: false };
    geoip.lookup.mockReturnValue({});
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);
  });

  it('should allow if country is in allowed list', () => {
    const user = { allowed_countries: 'US,CA', is_admin: false };
    geoip.lookup.mockReturnValue({ country: 'US' });
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);

    geoip.lookup.mockReturnValue({ country: 'CA' });
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);
  });

  it('should block if country is not in allowed list', () => {
    const user = { allowed_countries: 'US,CA', is_admin: false };
    geoip.lookup.mockReturnValue({ country: 'FR' });
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(false);
  });

  it('should handle case insensitivity and whitespace in allowed_countries', () => {
    const user = { allowed_countries: ' us , ca ', is_admin: false };
    geoip.lookup.mockReturnValue({ country: 'US' });
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);

    geoip.lookup.mockReturnValue({ country: 'CA' });
    expect(isIpAllowedForUser('8.8.8.8', user)).toBe(true);
  });
});
