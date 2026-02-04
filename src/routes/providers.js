import express from 'express';
import * as providerController from '../controllers/providerController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/providers', authenticateToken, providerController.getProviders);
router.post('/providers', authenticateToken, providerController.createProvider);
router.put('/providers/:id', authenticateToken, providerController.updateProvider);
router.delete('/providers/:id', authenticateToken, providerController.deleteProvider);

router.post('/providers/:id/sync', authenticateToken, providerController.syncProvider);
router.get('/providers/:id/channels', authenticateToken, providerController.getProviderChannels);
router.get('/providers/:id/categories', authenticateToken, providerController.getProviderCategories);
router.post('/providers/:providerId/import-category', authenticateToken, providerController.importCategory);
router.post('/providers/:providerId/import-categories', authenticateToken, providerController.importCategories);

export default router;
