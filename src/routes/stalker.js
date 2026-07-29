import express from 'express';
import { portal } from '../controllers/stalkerController.js';

const router = express.Router();
const parseForm = express.urlencoded({ extended: false, limit: '16kb' });

router.all(
  ['/portal.php', '/server/load.php', '/stalker_portal/server/load.php', '/c/server/load.php'],
  parseForm,
  portal
);

export default router;
