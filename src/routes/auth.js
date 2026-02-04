import express from 'express';
import * as authController from '../controllers/authController.js';
import { authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';

const router = express.Router();

router.post('/login', authLimiter, authController.login);
router.get('/verify-token', authenticateToken, authController.verifyToken);

router.post('/auth/otp/generate', authenticateToken, authController.generateOtp);
router.post('/auth/otp/verify', authenticateToken, authController.verifyOtp);
router.post('/auth/otp/disable', authenticateToken, authController.disableOtp);

router.post('/change-password', authLimiter, authenticateToken, authController.changePassword);
router.post('/player/token', authenticateToken, authController.createPlayerToken);

export default router;
