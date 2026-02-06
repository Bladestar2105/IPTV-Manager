import express from 'express';
import * as systemController from '../controllers/systemController.js';
import { authenticateToken } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { apiLimiter } from '../middleware/security.js';

const router = express.Router();

router.get('/settings', authenticateToken, systemController.getSettings);
router.post('/settings', authenticateToken, systemController.updateSettings);

router.get('/client-logs', authenticateToken, systemController.getClientLogs);
router.post('/client-logs', apiLimiter, systemController.createClientLog);
router.delete('/client-logs', authenticateToken, systemController.deleteClientLogs);

router.get('/security/logs', authenticateToken, systemController.getSecurityLogs);
router.delete('/security/logs', authenticateToken, systemController.deleteSecurityLogs);
router.get('/security/blocked', authenticateToken, systemController.getBlockedIps);
router.post('/security/block', authenticateToken, systemController.blockIp);
router.delete('/security/block/:id', authenticateToken, systemController.unblockIp);
router.get('/security/whitelist', authenticateToken, systemController.getWhitelist);
router.post('/security/whitelist', authenticateToken, systemController.whitelistIp);
router.delete('/security/whitelist/:id', authenticateToken, systemController.removeWhitelist);

router.post('/export', authenticateToken, systemController.exportData);
router.post('/import', authenticateToken, upload.single('file'), systemController.importData);

router.get('/sync-configs', authenticateToken, systemController.getSyncConfigs);
router.get('/sync-configs/:providerId/:userId', authenticateToken, systemController.getSyncConfig);
router.post('/sync-configs', authenticateToken, systemController.createSyncConfig);
router.put('/sync-configs/:id', authenticateToken, systemController.updateSyncConfig);
router.delete('/sync-configs/:id', authenticateToken, systemController.deleteSyncConfig);
router.get('/sync-logs', authenticateToken, systemController.getSyncLogs);

router.get('/statistics', authenticateToken, systemController.getStatistics);

export default router;
