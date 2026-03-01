import express from 'express';
import * as xtreamController from '../controllers/xtreamController.js';

const router = express.Router();

router.get('/player_api.php', xtreamController.playerApi);
router.get('/get.php', xtreamController.getPlaylist);
router.get('/xmltv.php', xtreamController.xmltv);
router.get('/api/player/playlist', xtreamController.playerPlaylist);
router.get('/api/player/channels.json', xtreamController.playerChannelsJson);

export default router;
