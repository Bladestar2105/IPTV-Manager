import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../utils/crypto.js';
import { authenticateToken } from '../middleware/auth.js';
import * as controller from '../controllers/aiController.js';

const router = express.Router();

router.use((req,res,next) => {
  res.set('Cache-Control','no-store');
  // Player/share/query tokens cannot authorize management or billable calls.
  if (!/^Bearer [^\s]+$/i.test(req.get('Authorization') || '')) return res.status(401).json({error:'ai_auth_required'});
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({error:'ai_cross_site'});
    const origin = req.get('Origin');
    if (origin) {
      let allowed = false;
      // Express honors forwarded host/protocol only when the socket's proxy is trusted.
      try { allowed = new URL(origin).origin === new URL(`${req.protocol}://${req.host}`).origin; } catch {}
      if (!allowed) return res.status(403).json({error:'ai_cross_site'});
    }
    if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({error:'ai_json_required'});
  }
  next();
});
// Ending this exact signed session only removes permission to finish a link.
// Keep it reachable after region/account access is revoked, without admitting
// any other management operation or cancelling another browser's session.
router.post('/codex/session/end', (req,res,next) => {
  try {
    const actor = jwt.verify(req.get('Authorization').split(' ')[1], JWT_SECRET, {algorithms:['HS256']});
    if (!Number.isSafeInteger(actor?.id) || actor.id < 1 || typeof actor.is_admin !== 'boolean' || !Number.isFinite(actor.exp)) throw new Error();
    req.user = {id:actor.id,is_admin:actor.is_admin};
  } catch { return res.status(403).json({error:'Invalid or expired token'}); }
  next();
}, controller.endAccountSession);
router.use(authenticateToken);

router.get('/settings',controller.settings);
router.put('/settings',controller.updateSettings);
router.get('/preferences',controller.preferences);
router.put('/preferences',controller.savePreferences);
router.get('/connections',controller.listConnections);
router.post('/connections',controller.createConnection);
router.put('/connections/:id',controller.updateConnection);
router.delete('/connections/:id',controller.deleteConnection);
router.post('/connections/:id/discover',controller.discover);
router.post('/connections/:id/test',controller.test);
router.get('/codex/status',controller.codexStatus);
router.post('/connections/:id/link',controller.startAccountLink);
router.get('/connections/:id/link/:loginId',controller.accountLinkStatus);
router.post('/connections/:id/link/:loginId/cancel',controller.cancelAccountLink);
router.post('/connections/:id/unlink',controller.unlinkAccount);
router.get('/connections/:id/account',controller.accountState);
router.get('/jobs',controller.listJobs);
router.post('/jobs',controller.createJob);
router.get('/jobs/:id',controller.getJob);
router.post('/jobs/:id/cancel',controller.cancelJob);
router.get('/proposals/:id',controller.getProposal);
router.post('/proposals/:id/apply',controller.applyProposal);
router.get('/changes',controller.listChanges);
router.get('/changes/:id',controller.getChange);
router.post('/changes/:id/undo',controller.undoChange);
router.get('/rules',controller.listRules);
router.post('/rules',controller.saveRule);
router.put('/rules/:id',controller.saveRule);
router.delete('/rules/:id',controller.deleteRule);
router.get('/conversations/:id',controller.getConversation);
router.post('/conversations/:id/messages',controller.followup);
router.delete('/conversations/:id',controller.deleteConversation);
router.get('/enrichments/:id',controller.getEnrichment);
router.get('/channels/:id/programs',controller.programs);
router.get('/usage',controller.usage);
router.delete('/history',controller.clearHistory);

export default router;
