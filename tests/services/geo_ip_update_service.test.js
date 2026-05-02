import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getGeoIpUpdatePlan, updateGeoIpDatabaseIfNeeded } from '../../src/services/geoIpUpdateService.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const writeGeoIpData = (dataPath, checksums = { country: 'country-v1', city: 'city-v1' }) => {
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(path.join(dataPath, 'country.checksum'), checksums.country);
  fs.writeFileSync(path.join(dataPath, 'city.checksum'), checksums.city);
  for (const file of ['geoip-country.dat', 'geoip-country6.dat', 'geoip-city-names.dat', 'geoip-city.dat', 'geoip-city6.dat']) {
    fs.writeFileSync(path.join(dataPath, file), 'data');
  }
};

const createChecksumFetch = ({ country = 'country-v1', city = 'city-v1' } = {}) => vi.fn(async (url) => ({
  ok: true,
  status: 200,
  text: async () => (String(url).includes('GeoLite2-Country-CSV') ? country : city),
}));

describe('geoIpUpdateService', () => {
  let tmpDir;
  let dataPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoip-update-'));
    dataPath = path.join(tmpDir, 'data');
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips the update process when MaxMind checksums and data files are current', async () => {
    writeGeoIpData(dataPath);
    const fetchImpl = createChecksumFetch();
    const runUpdateProcess = vi.fn();
    const reloadGeoIpData = vi.fn();

    const result = await updateGeoIpDatabaseIfNeeded('license123', {
      dataPath,
      fetchImpl,
      runUpdateProcess,
      reloadGeoIpData,
      logger: silentLogger,
    });

    expect(result.status).toBe('up_to_date');
    expect(result.updateAvailable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(runUpdateProcess).not.toHaveBeenCalled();
    expect(reloadGeoIpData).not.toHaveBeenCalled();
  });

  it('runs the update process when a remote checksum changed', async () => {
    writeGeoIpData(dataPath);
    const runUpdateProcess = vi.fn().mockResolvedValue();
    const reloadGeoIpData = vi.fn().mockResolvedValue();

    const result = await updateGeoIpDatabaseIfNeeded('license123', {
      dataPath,
      fetchImpl: createChecksumFetch({ country: 'country-v2' }),
      runUpdateProcess,
      reloadGeoIpData,
    });

    expect(result.status).toBe('updated');
    expect(result.updateAvailable).toBe(true);
    expect(result.changedDatabases.map((check) => check.type)).toEqual(['country']);
    expect(runUpdateProcess).toHaveBeenCalledWith('license123', expect.objectContaining({ force: false }));
    expect(reloadGeoIpData).toHaveBeenCalledTimes(1);
  });

  it('forces the updater when required data files are missing but checksums match', async () => {
    writeGeoIpData(dataPath);
    fs.unlinkSync(path.join(dataPath, 'geoip-city.dat'));
    const runUpdateProcess = vi.fn().mockResolvedValue();

    const result = await updateGeoIpDatabaseIfNeeded('license123', {
      dataPath,
      fetchImpl: createChecksumFetch(),
      runUpdateProcess,
      reloadGeoIpData: vi.fn().mockResolvedValue(),
    });

    expect(result.status).toBe('updated');
    expect(result.forceRequired).toBe(true);
    expect(result.changedDatabases.map((check) => check.type)).toEqual(['city']);
    expect(runUpdateProcess).toHaveBeenCalledWith('license123', expect.objectContaining({ force: true }));
  });

  it('reports checksum request failures before spawning the updater', async () => {
    writeGeoIpData(dataPath);
    const runUpdateProcess = vi.fn();

    await expect(getGeoIpUpdatePlan('license123', {
      dataPath,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 401, text: async () => '' })),
    })).rejects.toThrow('HTTP 401');

    expect(runUpdateProcess).not.toHaveBeenCalled();
  });
});
