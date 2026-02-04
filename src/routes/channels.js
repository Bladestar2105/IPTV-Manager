import express from 'express';
import * as channelController from '../controllers/channelController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/users/:userId/categories', authenticateToken, channelController.getUserCategories);
router.post('/users/:userId/categories', authenticateToken, channelController.createUserCategory);
router.put('/users/:userId/categories/reorder', authenticateToken, channelController.reorderUserCategories);

router.put('/user-categories/:id', authenticateToken, channelController.updateUserCategory);
router.delete('/user-categories/:id', authenticateToken, channelController.deleteUserCategory);
router.post('/user-categories/bulk-delete', authenticateToken, channelController.bulkDeleteUserCategories);
router.put('/user-categories/:id/adult', authenticateToken, channelController.updateUserCategoryAdult);

router.get('/user-categories/:catId/channels', authenticateToken, channelController.getCategoryChannels);
router.post('/user-categories/:catId/channels', authenticateToken, channelController.addUserChannel);
router.put('/user-categories/:catId/channels/reorder', authenticateToken, channelController.reorderUserChannels);

router.delete('/user-channels/:id', authenticateToken, channelController.deleteUserChannel);
router.post('/user-channels/bulk-delete', authenticateToken, channelController.bulkDeleteUserChannels);

router.get('/category-mappings/:providerId/:userId', authenticateToken, channelController.getCategoryMappings);
router.put('/category-mappings/:id', authenticateToken, channelController.updateCategoryMapping);

export default router;
