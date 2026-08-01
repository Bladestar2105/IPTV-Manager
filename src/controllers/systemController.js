import db from '../database/db.js';
import { clearSettingsCache } from '../utils/helpers.js';
import {
  createClientLog,
  getClientLogs,
  deleteClientLogs,
  getSecurityLogs,
  deleteSecurityLogs,
  getBlockedIps,
  blockIp,
  unblockIp,
  getWhitelist,
  whitelistIp,
  removeWhitelist
} from './systemSecurityController.js';
import {
  getSyncConfigs,
  getSyncConfig,
  createSyncConfig,
  updateSyncConfig,
  deleteSyncConfig,
  getSyncLogs
} from './systemSyncConfigController.js';
import {
  getStatistics,
  terminateActiveStream,
  resetStatistics
} from './systemStatisticsController.js';
import { exportData, updateGeoIpDatabase, importData } from './systemDataController.js';

export {
  createClientLog,
  getClientLogs,
  deleteClientLogs,
  getSecurityLogs,
  deleteSecurityLogs,
  getBlockedIps,
  blockIp,
  unblockIp,
  getWhitelist,
  whitelistIp,
  removeWhitelist,
  getSyncConfigs,
  getSyncConfig,
  createSyncConfig,
  updateSyncConfig,
  deleteSyncConfig,
  getSyncLogs,
  getStatistics,
  terminateActiveStream,
  resetStatistics,
  exportData,
  updateGeoIpDatabase,
  importData
};

export const getSettings = (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (e) { res.status(500).json({error: e.message}); }
};

export const updateSettings = (req, res) => {
  try {
    if (!req.user?.is_admin) return res.status(403).json({error: 'Access denied'});
    const settings = req.body;
    const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        insert.run(key, String(value));
      }
    })();
    clearSettingsCache();
    res.json({success: true});
  } catch (e) { res.status(500).json({error: e.message}); }
};

