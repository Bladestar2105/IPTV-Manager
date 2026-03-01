import express from 'express';
import * as backupController from '../controllers/backupController.js';
import { authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';

const router = express.Router();

router.get('/users/:userId/backups', authenticateToken, backupController.getBackups);
router.post('/users/:userId/backups', authLimiter, authenticateToken, backupController.createBackup);
router.post('/users/:userId/backups/:id/restore', authLimiter, authenticateToken, backupController.restoreBackup);
router.delete('/users/:userId/backups/:id', authenticateToken, backupController.deleteBackup);

export default router;
