import express from 'express';
import * as userController from '../controllers/userController.js';
import { authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';

const router = express.Router();

router.get('/users', authenticateToken, userController.getUsers);
router.post('/users', authLimiter, authenticateToken, userController.createUser);
router.put('/users/:id', authLimiter, authenticateToken, userController.updateUser);
router.delete('/users/:id', authenticateToken, userController.deleteUser);

export default router;
