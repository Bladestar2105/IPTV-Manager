import express from 'express';
import * as epgController from '../controllers/epgController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/epg/now', authenticateToken, epgController.getEpgNow);
router.get('/epg/schedule', epgController.getEpgSchedule); // Custom auth logic inside
router.get('/epg/channels', authenticateToken, epgController.getEpgChannels);

router.get('/epg-sources', authenticateToken, epgController.getEpgSources);
router.post('/epg-sources', authenticateToken, epgController.createEpgSource);
router.put('/epg-sources/:id', authenticateToken, epgController.updateEpgSourceEndpoint);
router.delete('/epg-sources/:id', authenticateToken, epgController.deleteEpgSource);
router.post('/epg-sources/:id/update', authenticateToken, epgController.triggerUpdateEpgSource);
router.post('/epg-sources/update-all', authenticateToken, epgController.updateAllEpgSources);
router.get('/epg-sources/available', authenticateToken, epgController.getAvailableEpgSources);

router.post('/mapping/manual', authenticateToken, epgController.manualMapping);
router.delete('/mapping/:id', authenticateToken, epgController.deleteMapping);
router.get('/mapping/:providerId', authenticateToken, epgController.getMappings);
router.post('/mapping/reset', authenticateToken, epgController.resetMapping);
router.post('/mapping/auto', authenticateToken, epgController.autoMapping);

export default router;
