import * as connections from '../services/ai/connections.js';
import * as jobs from '../services/ai/jobs.js';

// Avoid exposing upstream errors, database details, prompts or keys through the
// management API. Domain errors supply stable translated codes.
export const handle = action => async (req,res) => {
  try {
    const result = await action(req);
    res.set('Cache-Control','no-store');
    res.json(result ?? {success:true});
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const code = /^[a-zA-Z][a-zA-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : status === 500 ? 'ai_internal_error' : 'ai_request_rejected';
    res.status(status).json({error:code,code});
  }
};

export const settings = handle(req => connections.getAiSettings(req.user));
export const updateSettings = handle(req => connections.updateAiSettings(req.user,req.body));
export const preferences = handle(req => connections.getPreferences(req.user));
export const savePreferences = handle(req => connections.savePreferences(req.user,req.body));
export const listConnections = handle(req => connections.listConnections(req.user));
export const createConnection = handle(req => connections.saveConnection(req.user,req.body));
export const updateConnection = handle(req => connections.saveConnection(req.user,req.body,req.params.id));
export const deleteConnection = handle(req => connections.deleteConnection(req.user,req.params.id));
export const discover = handle(req => connections.discoverModels(req.user,req.params.id));
export const test = handle(req => connections.testModels(req.user,req.params.id,req.body));
export const createJob = handle(req => jobs.createJob(req.user,req.body,req.get('Idempotency-Key') || req.body.idempotency_key));
export const listJobs = handle(req => jobs.listJobs(req.user));
export const getJob = handle(req => jobs.getJob(req.user,req.params.id));
export const cancelJob = handle(req => jobs.cancelJob(req.user,req.params.id));
export const usage = handle(req => jobs.getUsage(req.user));
export const clearHistory = handle(req => jobs.clearHistory(req.user));
export const programs = handle(async req => {
  const access = connections.requireAiAccess(req.user,'text');
  const {buildContext} = await import('../services/ai/context.js');
  const {searchLocally,timezoneName} = await import('../services/ai/searchAndEpg.js');
  const context = buildContext(req.user,{feature:'text',user_id:req.query.user_id,provider_channel_id:req.params.id});
  const result = searchLocally(req.user,context,{type:'program'},timezoneName(req.query.timezone || access.preferences.timezone));
  return {items:result.items.map(({provider_channel_id,title,description,start,stop,local_start,timezone,program}) =>
    ({provider_channel_id,title,description,start,stop,local_start,timezone,program})),truncated:result.truncated};
});

export const getProposal = handle(async req => {
  const {getProposal} = await import('../services/ai/proposals.js');
  return getProposal(req.user,req.params.id);
});
export const applyProposal = handle(async req => {
  const {applyProposal} = await import('../services/ai/proposals.js');
  return applyProposal(req.user,req.params.id,req.body);
});
export const getChange = handle(async req => {
  const {getChange} = await import('../services/ai/proposals.js');
  return getChange(req.user,req.params.id);
});
export const listChanges = handle(async req => {
  const {listChanges} = await import('../services/ai/proposals.js');
  return listChanges(req.user,req.query.user_id);
});
export const undoChange = handle(async req => {
  const {undoChange} = await import('../services/ai/proposals.js');
  return undoChange(req.user,req.params.id);
});
export const listRules = handle(async req => {
  const {listRules} = await import('../services/ai/library.js');
  return listRules(req.user,req.query.user_id);
});
export const saveRule = handle(async req => {
  connections.requireAiFeatureAccess(req.user,'cleanup');
  const {saveRule} = await import('../services/ai/library.js');
  return saveRule(req.user,req.body,req.params.id || null);
});
export const deleteRule = handle(async req => {
  const {deleteRule} = await import('../services/ai/library.js');
  return deleteRule(req.user,req.params.id);
});
export const getConversation = handle(async req => {
  const {getConversation} = await import('../services/ai/library.js');
  return getConversation(req.user,req.params.id);
});
export const deleteConversation = handle(async req => {
  const {deleteConversation} = await import('../services/ai/library.js');
  return deleteConversation(req.user,req.params.id);
});
export const followup = handle(async req => {
  const {getConversation} = await import('../services/ai/library.js');
  const conversation = await getConversation(req.user,req.params.id);
  return jobs.createJob(req.user,{...req.body,feature:'search',user_id:conversation.user_id,conversation_id:req.params.id},req.get('Idempotency-Key') || req.body.idempotency_key);
});
export const getEnrichment = handle(async req => {
  const {getEnrichment} = await import('../services/ai/library.js');
  return getEnrichment(req.user,req.params.id);
});
