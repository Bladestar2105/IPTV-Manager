import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';

const MAXMIND_BASE_URL = 'https://download.maxmind.com/app/geoip_download';
const GEOIP_LITE_ROOT = path.resolve('node_modules/geoip-lite');

const DATABASES = [
  {
    type: 'country',
    editionId: 'GeoLite2-Country-CSV',
    checksumFile: 'country.checksum',
    requiredFiles: ['geoip-country.dat', 'geoip-country6.dat'],
  },
  {
    type: 'city',
    editionId: 'GeoLite2-City-CSV',
    checksumFile: 'city.checksum',
    requiredFiles: ['geoip-city-names.dat', 'geoip-city.dat', 'geoip-city6.dat'],
  },
];

const normalizeChecksum = (value) => String(value || '').trim();

const buildChecksumUrl = (editionId, licenseKey) => {
  const params = new URLSearchParams({
    edition_id: editionId,
    suffix: 'zip.sha256',
    license_key: licenseKey,
  });
  return `${MAXMIND_BASE_URL}?${params.toString()}`;
};

const getGeoIpLiteRoot = (overrideRoot) => overrideRoot || GEOIP_LITE_ROOT;

const getGeoIpDataPath = (overrideRoot, overrideDataPath) => {
  if (overrideDataPath) return overrideDataPath;
  return path.join(getGeoIpLiteRoot(overrideRoot), 'data');
};

const readLocalChecksum = (dataPath, checksumFile) => {
  try {
    return normalizeChecksum(fs.readFileSync(path.join(dataPath, checksumFile), 'utf8'));
  } catch {
    return '';
  }
};

const getMissingRequiredFiles = (dataPath, requiredFiles) => (
  requiredFiles.filter((file) => !fs.existsSync(path.join(dataPath, file)))
);

const fetchRemoteChecksum = async (database, licenseKey, fetchImpl) => {
  const response = await fetchImpl(buildChecksumUrl(database.editionId, licenseKey), {
    headers: {
      'User-Agent': 'IPTV-Manager GeoIP updater',
    },
  });

  if (!response.ok) {
    throw new Error(`MaxMind ${database.type} checksum request failed: HTTP ${response.status}`);
  }

  const checksum = normalizeChecksum(await response.text());
  if (!checksum) {
    throw new Error(`MaxMind ${database.type} checksum response was empty`);
  }
  return checksum;
};

export const getGeoIpUpdatePlan = async (licenseKey, options = {}) => {
  if (!licenseKey) throw new Error('A MaxMind License Key is required to update the GeoIP database.');

  const fetchImpl = options.fetchImpl || fetch;
  const dataPath = getGeoIpDataPath(options.geoIpLiteRoot, options.dataPath);
  const checks = [];

  for (const database of DATABASES) {
    const localChecksum = readLocalChecksum(dataPath, database.checksumFile);
    const remoteChecksum = await fetchRemoteChecksum(database, licenseKey, fetchImpl);
    const missingRequiredFiles = getMissingRequiredFiles(dataPath, database.requiredFiles);
    const checksumChanged = localChecksum !== remoteChecksum;
    const needsUpdate = options.force || checksumChanged || missingRequiredFiles.length > 0;

    checks.push({
      type: database.type,
      localChecksum,
      remoteChecksum,
      checksumChanged,
      missingRequiredFiles,
      needsUpdate,
      forceRequired: missingRequiredFiles.length > 0 && !checksumChanged,
    });
  }

  const changedDatabases = checks.filter((check) => check.needsUpdate);
  return {
    updateAvailable: changedDatabases.length > 0,
    changedDatabases,
    checks,
    forceRequired: Boolean(options.force || changedDatabases.some((check) => check.forceRequired)),
  };
};

export const runGeoIpUpdateProcess = (licenseKey, options = {}) => new Promise((resolve, reject) => {
  const geoIpLiteRoot = getGeoIpLiteRoot(options.geoIpLiteRoot);
  const scriptPath = path.join(geoIpLiteRoot, 'scripts', 'updatedb.js');
  const args = ['--max-old-space-size=4096', scriptPath, `license_key=${licenseKey}`];
  if (options.force) args.push('force');

  const child = spawn(process.execPath, args, {
    cwd: geoIpLiteRoot,
    env: { ...process.env, LICENSE_KEY: licenseKey },
    stdio: options.stdio || 'inherit',
  });

  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`GeoIP update process exited with code ${code}`));
    }
  });
});

export const reloadGeoIpData = async () => {
  const geoip = (await import('geoip-lite')).default;
  geoip.reloadDataSync();
};

export const updateGeoIpDatabaseIfNeeded = async (licenseKey, options = {}) => {
  const plan = await getGeoIpUpdatePlan(licenseKey, options);
  if (!plan.updateAvailable) {
    return { status: 'up_to_date', ...plan };
  }

  const runUpdate = options.runUpdateProcess || runGeoIpUpdateProcess;
  const reload = options.reloadGeoIpData || reloadGeoIpData;

  await runUpdate(licenseKey, {
    geoIpLiteRoot: options.geoIpLiteRoot,
    force: plan.forceRequired,
    stdio: options.stdio,
  });
  await reload();

  return { status: 'updated', ...plan };
};
