import express from 'express';
import * as hdhrController from '../controllers/hdhrController.js';
import * as streamController from '../controllers/streamController.js';

const router = express.Router();

router.get(['/:token/discover.json', '/:token//discover.json'], hdhrController.discover);
router.get(['/:token', '/:token/', '/:token/device.xml', '/:token//device.xml'], hdhrController.deviceXml);
router.get(['/:token/lineup_status.json', '/:token//lineup_status.json'], hdhrController.lineupStatus);
router.get(['/:token/lineup.json', '/:token//lineup.json'], hdhrController.lineup);
router.get('/:token/auto/v:channelId', hdhrController.auto);

// Stream controllers authenticate req.params.token as an HDHomeRun token.
router.get('/:token/stream/:stream_id.ts', streamController.proxyLive);
router.get('/:token/movie/:stream_id.:ext', streamController.proxyMovie);

export default router;
