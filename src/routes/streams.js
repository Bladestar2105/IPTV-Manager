import express from 'express';
import * as streamController from '../controllers/streamController.js';

const router = express.Router();

router.get('/live/mpd/:username/:password/:stream_id/*', streamController.proxyMpd);
router.get(['/live/:username/:password/:stream_id.ts', '/live/:username/:password/:stream_id.m3u8', '/live/:username/:password/:stream_id.mp4'], streamController.proxyLive);
router.get(['/live/segment/:username/:password/seg.ts', '/live/segment/:username/:password/seg.key'], streamController.proxySegment);
router.get('/movie/:username/:password/:stream_id.:ext', streamController.proxyMovie);
router.get('/series/:username/:password/:episode_id.:ext', streamController.proxySeries);
router.get('/timeshift/:username/:password/:duration/:start/:stream_id.ts', streamController.proxyTimeshift);

export default router;
