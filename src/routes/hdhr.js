import express from 'express';
import * as hdhrController from '../controllers/hdhrController.js';

const router = express.Router();

router.get('/:username/:password/discover.json', hdhrController.discover);
router.get('/:username/:password/lineup_status.json', hdhrController.lineupStatus);
router.get('/:username/:password/lineup.json', hdhrController.lineup);
router.get('/:username/:password/auto/v:channelId', hdhrController.auto);

export default router;
