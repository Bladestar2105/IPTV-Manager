import express from 'express';
import * as shareController from '../controllers/shareController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.post('/', authenticateToken, shareController.createShare);
router.get('/', authenticateToken, shareController.getShares);
router.delete('/:token', authenticateToken, shareController.deleteShare);

export default router;
