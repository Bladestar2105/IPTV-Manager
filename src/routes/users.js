import express from 'express';
import * as userController from '../controllers/userController.js';
import * as stalkerDeviceController from '../controllers/stalkerDeviceController.js';
import { authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';

const router = express.Router();

router.get('/users', authenticateToken, userController.getUsers);
router.post('/users', authLimiter, authenticateToken, userController.createUser);
router.get('/users/:userId/stalker-devices', authenticateToken, stalkerDeviceController.getStalkerDevices);
router.post('/users/:userId/stalker-devices', authLimiter, authenticateToken, stalkerDeviceController.createStalkerDevice);
router.put('/users/:userId/stalker-devices/:deviceId', authLimiter, authenticateToken, stalkerDeviceController.updateStalkerDevice);
router.delete('/users/:userId/stalker-devices/:deviceId', authenticateToken, stalkerDeviceController.deleteStalkerDevice);
router.put('/users/:id', authLimiter, authenticateToken, userController.updateUser);
router.delete('/users/:id', authenticateToken, userController.deleteUser);

export default router;
