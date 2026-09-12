import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-proposals-'));
process.env.DATA_DIR=dir;
let db,createProposal,getProposal,applyProposal,undoChange,saveRule,applyRulesAfterSync,listRules,prunePrivateRecords,listChanges,getChange;
const actor={id:711,is_admin:false,username:'one'};
const payload={feature:'cleanup',user_id:711};
beforeAll(async()=>{
  ({default:db}=await import('../src/database/db.js'));
  (await import('../src/database/db.js')).initDb(true);
  ({createProposal,getProposal,applyProposal,undoChange,listChanges,getChange}=await import('../src/services/ai/proposals.js'));
  ({saveRule,applyRulesAfterSync,listRules}=await import('../src/services/ai/library.js'));
  ({prunePrivateRecords}=await import('../src/services/ai/context.js'));
});
beforeEach(()=>{
  for(const table of ['ai_changes','ai_proposals','ai_rules','ai_preferences','user_channels','user_categories','provider_channels','providers','users','admin_users']) db.prepare(`DELETE FROM ${table}`).run();
  db.exec(`INSERT INTO users(id,username,password) VALUES(711,'one','x'),(712,'two','x');
    INSERT INTO providers(id,name,url,username,password,user_id) VALUES(811,'p','https://invalid','x','x',711),(812,'p2','https://invalid','x','x',712);
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(911,811,1,'DE | News'),(912,811,2,'DE | Sport'),(913,812,3,'Foreign');
    INSERT INTO user_categories(id,user_id,name) VALUES(1011,711,'One'),(1012,712,'Two');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,sort_order,assignment_origin,mapping_id) VALUES(1111,1011,911,0,'mapping',99),(1112,1011,912,1,'manual',NULL),(1113,1012,913,0,'manual',NULL);`);
  db.prepare("INSERT INTO settings(key,value) VALUES('ai_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({enabled:true,allowed_user_ids:[711,712],functions:['list','cleanup','duplicates']}));
  for(const owner of ['user:711','admin:711']) db.prepare('INSERT INTO ai_preferences(owner_key,data_json) VALUES(?,?)').run(owner,JSON.stringify({enabled:true}));
});
afterAll(()=>{db?.close();fs.rmSync(dir,{recursive:true,force:true});});
const rename=()=>createProposal(actor,payload,[{type:'rename_channel',user_channel_id:1111,value:'News'}],'Clean');
it.each([
  ['cleanup',{type:'create_category',key:'new',name:'New',category_type:'live'}],
  ['cleanup',{type:'assign_channel',provider_channel_id:912,category_id:1011}],
  ...['search','diagnose','text','setup','unknown','toString'].map(feature=>[feature,{type:'rename_channel',user_channel_id:1111,value:'News'}])
])('rejects actions outside the closed %s contract before storing a proposal',(feature,action)=>{
  expect(()=>createProposal(actor,{...payload,feature},[action])).toThrow(/AI_INVALID_ACTION/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1111').get().custom_name).toBe('');
});
it('rechecks feature permission on direct confirmation after preview without a model connection',()=>{
  const proposal=rename();
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  db.prepare("UPDATE settings SET value=json_set(value,'$.functions',json('[\"list\"]')) WHERE key='ai_policy'").run();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'revoked-preview'})).toThrow(expect.objectContaining({code:'AI_FORBIDDEN',status:403}));
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT status FROM ai_proposals WHERE id=?').get(proposal.id).status).toBe('pending');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_connections').get().n).toBe(0);
});
it('stores exact preview, preserves mapping origin, is idempotent and conditionally undoes',()=>{
  const proposal=rename();
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1111').get().custom_name).toBe('');
  expect(proposal.actions[0]).toMatchObject({before:{custom_name:''},after:{custom_name:'News'}});
  const selection={action_ids:[proposal.actions[0].id],idempotency_key:'confirmation-one'};
  const applied=applyProposal(actor,proposal.id,selection);
  expect(applyProposal(actor,proposal.id,selection)).toEqual(applied);
  expect(db.prepare('SELECT assignment_origin,mapping_id,custom_name FROM user_channels WHERE id=1111').get()).toEqual({assignment_origin:'mapping',mapping_id:99,custom_name:'News'});
  expect(undoChange(actor,applied.change_id).status).toBe('undone');
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1111').get().custom_name).toBe('');
});
it('rejects foreign IDs, revoked rights, stale values and unselected manual overrides',()=>{
  expect(()=>createProposal(actor,payload,[{type:'rename_channel',user_channel_id:1113,value:'Leak'}],'')).toThrow();
  const proposal=rename();
  expect(()=>getProposal({id:712,is_admin:false},proposal.id)).toThrow();
  db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1111').run();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'k'})).toThrow();
  db.prepare("UPDATE user_channels SET authorization_revoked=0,custom_name='Mine' WHERE id=1111").run();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'k'})).toThrow();
  expect(()=>rename()).toThrow();
});
it('refuses undo conflicts instead of overwriting later manual values',()=>{
  const proposal=rename();
  const applied=applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'k'});
  db.prepare("UPDATE user_channels SET custom_name='Later' WHERE id=1111").run();
  expect(()=>undoChange(actor,applied.change_id)).toThrow(/AI_UNDO_CONFLICT/);
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1111').get().custom_name).toBe('Later');
});
it('validates create-category dependencies and uses normal manual add semantics',()=>{
  const proposal=createProposal(actor,{...payload,feature:'list'},[
    {type:'create_category',key:'sports',name:'Sports',category_type:'live'},
    {type:'assign_channel',provider_channel_id:912,category_key:'sports'}],'New list');
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[1].id],idempotency_key:'missing'})).toThrow();
  const applied=applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(x=>x.id),idempotency_key:'both'});
  const category=db.prepare("SELECT id FROM user_categories WHERE name='Sports'").get();
  expect(db.prepare('SELECT assignment_origin,mapping_id FROM user_channels WHERE user_category_id=?').get(category.id)).toEqual({assignment_origin:'manual',mapping_id:null});
  undoChange(actor,applied.change_id);
  expect(db.prepare("SELECT id FROM user_categories WHERE name='Sports'").get()).toBeUndefined();
});
it('resolves forward category keys while preserving assignment order, confirmation and Undo',()=>{
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  const categories=db.prepare('SELECT * FROM user_categories ORDER BY id').all();
  const input=[
    {type:'assign_channel',provider_channel_id:912,category_key:'sports'},
    {type:'rename_channel',user_channel_id:1111,value:'News'},
    {type:'create_category',key:'sports',name:'Sports',category_type:'live'},
    {type:'assign_channel',provider_channel_id:911,category_key:'sports'}
  ];
  const proposal=createProposal(actor,{...payload,feature:'list'},input,'New list');
  expect(input[0].type).toBe('assign_channel');
  expect(proposal.actions.map(action=>action.type)).toEqual(['create_category','assign_channel','rename_channel','assign_channel']);
  for(const index of [1,3]) expect(proposal.actions[index].dependencies).toEqual([proposal.actions[0].id]);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM user_categories ORDER BY id').all()).toEqual(categories);
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[1].id],idempotency_key:'missing-forward'})).toThrow(/AI_MISSING_DEPENDENCY/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
  const selection={action_ids:proposal.actions.map(action=>action.id),idempotency_key:'forward'};
  const applied=applyProposal(actor,proposal.id,selection);
  expect(applyProposal(actor,proposal.id,selection)).toEqual(applied);
  const category=db.prepare("SELECT id FROM user_categories WHERE name='Sports'").get();
  expect(db.prepare('SELECT provider_channel_id,sort_order,assignment_origin,mapping_id FROM user_channels WHERE user_category_id=? ORDER BY sort_order').all(category.id)).toEqual([
    {provider_channel_id:912,sort_order:0,assignment_origin:'manual',mapping_id:null},
    {provider_channel_id:911,sort_order:1,assignment_origin:'manual',mapping_id:null}
  ]);
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1111').get().custom_name).toBe('News');
  expect(undoChange(actor,applied.change_id).status).toBe('undone');
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM user_categories ORDER BY id').all()).toEqual(categories);
});
it.each([
  ['unknown key',[{type:'assign_channel',provider_channel_id:912,category_key:'missing'}],'AI_INVALID_DEPENDENCY'],
  ['duplicate key',[
    {type:'assign_channel',provider_channel_id:912,category_key:'sports'},
    {type:'create_category',key:'sports',name:'Sports',category_type:'live'},
    {type:'create_category',key:'sports',name:'Other',category_type:'live'}
  ],'AI_INVALID_ACTION']
])('rejects %s without persisting or applying any action',(_case,actions,code)=>{
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  const categories=db.prepare('SELECT * FROM user_categories ORDER BY id').all();
  expect(()=>createProposal(actor,{...payload,feature:'list'},actions)).toThrow(code);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM user_categories ORDER BY id').all()).toEqual(categories);
});
it.each([['new',1013],['existing',1011]])('previews, confirms and undoes %s live-source assignments to radio categories',(_case,categoryId)=>{
  if(categoryId===1013) db.exec("INSERT INTO user_categories(id,user_id,name,type) VALUES(1013,711,'Radio','radio')");
  else db.exec("UPDATE user_categories SET type='radio' WHERE id=1011");
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  const proposal=createProposal(actor,{...payload,feature:'list'},[{type:'assign_channel',provider_channel_id:911,category_id:categoryId}],'Radio list');
  expect(getProposal(actor,proposal.id)).toMatchObject({status:'pending',actions:proposal.actions});
  expect(proposal.actions[0]).toMatchObject({category_id:categoryId,provider_channel_id:911,after:{assignment_origin:'manual',mapping_id:null,granted_by_admin:0,authorization_revoked:0}});
  expect(proposal.actions[0].before).toEqual(categoryId===1011?{sort_order:0,is_hidden:0,assignment_origin:'mapping',mapping_id:99,granted_by_admin:0,authorization_revoked:0}:null);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[],idempotency_key:'radio'})).toThrow(/AI_INVALID_CONFIRMATION/);
  const selection={action_ids:[proposal.actions[0].id],idempotency_key:'radio'};
  const applied=applyProposal(actor,proposal.id,selection);
  expect(applyProposal(actor,proposal.id,selection)).toEqual(applied);
  const assignment=db.prepare('SELECT * FROM user_channels WHERE user_category_id=? AND provider_channel_id=911').get(categoryId);
  expect(assignment).toMatchObject({assignment_origin:'manual',mapping_id:null,is_hidden:0,granted_by_admin:0,authorization_revoked:0});
  if(categoryId===1013) expect(db.prepare('SELECT * FROM user_channels WHERE id=1111').get()).toEqual(before[0]);
  else expect(assignment.id).toBe(1111);
  expect(undoChange(actor,applied.change_id).status).toBe('undone');
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
});
it.each([
  ['live','movie'],['live','series'],['movie','live'],['movie','series'],
  ['movie','radio'],['series','live'],['series','movie'],['series','radio']
])('rejects incompatible %s sources in %s categories before storing a proposal',(streamType,categoryType)=>{
  db.prepare('UPDATE provider_channels SET stream_type=? WHERE id=911').run(streamType);
  db.prepare("INSERT INTO user_categories(id,user_id,name,type) VALUES(1013,711,'Target',?)").run(categoryType);
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(()=>createProposal(actor,{...payload,feature:'list'},[{type:'assign_channel',provider_channel_id:911,category_id:1013}])).toThrow(/AI_CATEGORY_TYPE_MISMATCH/);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(0);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
});
it.each([
  ['source type',"UPDATE provider_channels SET stream_type='movie' WHERE id=911",'AI_STALE_SOURCE'],
  ['category type',"UPDATE user_categories SET type='movie' WHERE id=1013",'AI_STALE_PROPOSAL'],
  ['source authorization',"UPDATE user_channels SET authorization_revoked=1 WHERE id=1111",'AI_SOURCE_UNAVAILABLE'],
  ['category ownership',"UPDATE user_categories SET user_id=712 WHERE id=1013",'AI_FORBIDDEN'],
  ['list permission',"UPDATE settings SET value=json_set(value,'$.functions',json('[\"cleanup\"]')) WHERE key='ai_policy'",'AI_FORBIDDEN']
])('rejects radio confirmation after %s changes',(_case,change,code)=>{
  db.exec("INSERT INTO user_categories(id,user_id,name,type) VALUES(1013,711,'Radio','radio')");
  const proposal=createProposal(actor,{...payload,feature:'list'},[{type:'assign_channel',provider_channel_id:911,category_id:1013}],'Radio list');
  db.exec(change);
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'changed-radio'})).toThrow(expect.objectContaining({code}));
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT status FROM ai_proposals WHERE id=?').get(proposal.id).status).toBe('pending');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
});
it('requires confirmation for declarative rules and defaults future application off',()=>{
  const proposal=rename();
  const input={proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Strip DE',operation:'strip_prefix',match:'DE | ',replacement:''};
  expect(()=>saveRule(actor,input)).toThrow();
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'apply'});
  const rule=saveRule(actor,input);
  expect(rule.enabled).toBe(false);
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:0});
  saveRule(actor,{...input,enabled:true},rule.id);
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:1});
  expect(db.prepare('SELECT custom_name,assignment_origin FROM user_channels WHERE id=1112').get()).toEqual({custom_name:'Sport',assignment_origin:'manual'});
});
it('bounds expired change history during rule-only syncs and preserves current Undo records',()=>{
  const now=Date.now(),cutoff=now-30*86400000,clock=vi.spyOn(Date,'now').mockReturnValue(now);
  try {
    const proposal=rename();
    applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'retained-history'});
    const rule=saveRule(actor,{proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Cleanup',operation:'strip_prefix',match:'DE | ',enabled:true});
    db.prepare("UPDATE ai_preferences SET data_json=json_set(data_json,'$.auto_sync_summary',json('false')) WHERE owner_key='user:711'").run();
    const insert=db.prepare("INSERT INTO ai_changes(id,owner_key,user_id,data_json,status,created_at) VALUES (?,'user:711',711,'{}','applied',?)");
    for(let i=0;i<201;i++) insert.run(`expired-rule-${i}`,cutoff-1-i);
    insert.run('retained-cutoff',cutoff);
    const controls=db.prepare("SELECT * FROM ai_changes WHERE id NOT LIKE 'expired-rule-%' ORDER BY id").all();
    const remaining=[];
    for(let i=0;i<3;i++) {
      const channel=Number(db.prepare("INSERT INTO provider_channels(provider_id,remote_stream_id,name) VALUES (811,?,?)").run(10+i,`DE | Added ${i}`).lastInsertRowid);
      const assignment=Number(db.prepare("INSERT INTO user_channels(user_category_id,provider_channel_id,assignment_origin) VALUES (1011,?,'manual')").run(channel).lastInsertRowid);
      expect(applyRulesAfterSync(711,[channel])).toEqual({applied:1});
      expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=?').get(assignment).custom_name).toBe(`Added ${i}`);
      remaining.push(db.prepare('SELECT COUNT(*) AS n FROM ai_changes WHERE created_at<?').get(cutoff).n);
    }
    expect(remaining).toEqual([101,1,0]);
    for(const row of controls) expect(db.prepare('SELECT * FROM ai_changes WHERE id=?').get(row.id)).toEqual(row);
    const changes=db.prepare("SELECT id FROM ai_changes WHERE json_extract(data_json,'$.rule_id')=?").all(rule.id);
    expect(changes).toHaveLength(3);
    for(const change of changes) expect(undoChange(actor,change.id).status).toBe('undone');
    expect(db.prepare('SELECT enabled FROM ai_rules WHERE id=?').get(rule.id).enabled).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_jobs').get().n).toBe(0);
  } finally {clock.mockRestore();}
});
it.each([
  ['Web UI access',"UPDATE users SET webui_access=0 WHERE id=711"],
  ['AI allowlist access',"UPDATE settings SET value=json_set(value,'$.allowed_user_ids',json('[]')) WHERE key='ai_policy'"],
  ['cleanup access',"UPDATE settings SET value=json_set(value,'$.functions',json('[\"list\"]')) WHERE key='ai_policy'"],
  ['server AI enablement',"UPDATE settings SET value=json_set(value,'$.enabled',json('false')) WHERE key='ai_policy'"],
  ['personal AI enablement',"UPDATE ai_preferences SET data_json=json_set(data_json,'$.enabled',json('false')) WHERE owner_key='user:711'"],
  ['account activity',"UPDATE users SET is_active=0 WHERE id=711"],
  ['account validity',"UPDATE users SET expiry_date=1 WHERE id=711"]
])('skips automatic rules after %s is revoked',(_permission,revoke)=>{
  const proposal=rename();
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'revoked-rule'});
  const rule=saveRule(actor,{proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Cleanup',operation:'strip_prefix',match:'DE | ',enabled:true});
  const before=db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n;
  db.exec(revoke);
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:0});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1112').get().custom_name).toBe('');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(before);
  expect(db.prepare('SELECT enabled FROM ai_rules WHERE id=?').get(rule.id).enabled).toBe(1);
});
it('continues authorized administrator rules after skipping a revoked user rule without a model connection',()=>{
  const first=rename();
  applyProposal(actor,first.id,{action_ids:[first.actions[0].id],idempotency_key:'user-rule'});
  const userRule=saveRule(actor,{proposal_id:first.id,action_id:first.actions[0].id,name:'User cleanup',operation:'strip_prefix',match:'DE | ',enabled:true});
  db.prepare('UPDATE ai_rules SET created_at=0 WHERE id=?').run(userRule.id);
  const admin={id:711,is_admin:true};
  db.prepare("INSERT INTO admin_users(id,username,password) VALUES(711,'rule-admin','x')").run();
  const second=createProposal(admin,payload,[{type:'rename_channel',user_channel_id:1112,value:'Sport'}],'Admin cleanup');
  applyProposal(admin,second.id,{action_ids:[second.actions[0].id],idempotency_key:'admin-rule'});
  const adminRule=saveRule(admin,{proposal_id:second.id,action_id:second.actions[0].id,name:'Admin cleanup',operation:'strip_prefix',match:'DE | ',enabled:true});
  db.exec(`INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(914,811,4,'DE | Movies');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,assignment_origin) VALUES(1114,1011,914,'manual');
    UPDATE users SET webui_access=0 WHERE id=711;`);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_connections').get().n).toBe(0);
  expect(applyRulesAfterSync(711,[914])).toEqual({applied:1});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1114').get().custom_name).toBe('Movies');
  expect(db.prepare("SELECT owner_key,json_extract(data_json,'$.rule_id') AS rule_id FROM ai_changes WHERE json_extract(data_json,'$.rule_id') IS NOT NULL").all()).toEqual([{owner_key:'admin:711',rule_id:adminRule.id}]);
});
it('rejects an administrator retargeting a rule to another user without changing its future application',()=>{
  const admin={id:711,is_admin:true};
  db.exec(`INSERT INTO admin_users(id,username,password) VALUES(711,'rule-admin','x');
    UPDATE provider_channels SET name='FR | News' WHERE id=913;
    INSERT INTO provider_channels(id,provider_id,remote_stream_id,name) VALUES(914,812,4,'FR | Sport');
    INSERT INTO user_channels(id,user_category_id,provider_channel_id,sort_order,assignment_origin) VALUES(1114,1012,914,1,'manual');`);
  const confirmedRename=(userId,assignmentId)=>{
    const proposal=createProposal(admin,{feature:'cleanup',user_id:userId},[{type:'rename_channel',user_channel_id:assignmentId,value:'News'}],'Clean');
    applyProposal(admin,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:`rule-user-${userId}`});
    return proposal;
  };
  const first=confirmedRename(711,1111);
  const rule=saveRule(admin,{proposal_id:first.id,action_id:first.actions[0].id,name:'Strip DE',operation:'strip_prefix',match:'DE | ',enabled:true});
  const before=db.prepare('SELECT * FROM ai_rules WHERE id=?').get(rule.id);
  const second=confirmedRename(712,1113);

  expect(()=>saveRule(admin,{proposal_id:second.id,action_id:second.actions[0].id,name:'Strip FR',match:'FR | '},rule.id)).toThrow(/AI_INVALID_RULE/);
  expect(db.prepare('SELECT * FROM ai_rules WHERE id=?').get(rule.id)).toEqual(before);
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:1});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1112').get().custom_name).toBe('Sport');
  expect(applyRulesAfterSync(712,[914])).toEqual({applied:0});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1114').get().custom_name).toBe('');
});
it.each([
  ['creating','ai_proposals','updated_at',false],
  ['changing','ai_proposals','updated_at',true],
  ['creating','ai_changes','created_at',false],
  ['changing','ai_changes','created_at',true]
])('rejects %s rules from expired %s confirmations before cleanup',(_operation,table,time,editing)=>{
  const proposal=rename();
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'expired-confirmation'});
  const input={proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Strip DE',operation:'strip_prefix',match:'DE | ',enabled:true};
  const rule=saveRule(actor,input);
  db.prepare(`UPDATE ${table} SET ${time}=?`).run(Date.now()-31*86400000);
  const before=db.prepare('SELECT * FROM ai_rules').all();

  expect(()=>saveRule(actor,editing?{operation:'replace_literal'}:input,editing?rule.id:null)).toThrow(/AI_NOT_FOUND/);
  expect(db.prepare('SELECT * FROM ai_rules').all()).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_proposals').get().n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(1);
  expect(saveRule(actor,{name:'Retained cleanup',enabled:false},rule.id)).toMatchObject({name:'Retained cleanup',enabled:false,operation:'strip_prefix'});
});
it('keeps confirmed rules editable after their proposal and change records are pruned',()=>{
  const proposal=rename();
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'retained-rule'});
  const input={proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Strip DE',operation:'strip_prefix',match:'DE | ',enabled:true};
  const rule=saveRule(actor,input);
  const expired=Date.now()-31*86400000;
  db.prepare('UPDATE ai_proposals SET updated_at=?').run(expired);
  db.prepare('UPDATE ai_changes SET created_at=?').run(expired);
  prunePrivateRecords();
  expect(db.prepare('SELECT id FROM ai_proposals').all()).toEqual([]);
  expect(db.prepare('SELECT id FROM ai_changes').all()).toEqual([]);

  expect(saveRule(actor,{...listRules(actor)[0],enabled:false},rule.id).enabled).toBe(false);
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:0});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1112').get().custom_name).toBe('');
  const disabled=db.prepare('SELECT * FROM ai_rules WHERE id=?').get(rule.id);
  for(const update of [{operation:'replace_literal'},{match:'DE'},{replacement:'New'},{exceptions:['Sport']},{proposal_id:'missing'},{action_id:'missing'}]) {
    expect(()=>saveRule(actor,update,rule.id)).toThrow(/AI_NOT_FOUND/);
    expect(db.prepare('SELECT * FROM ai_rules WHERE id=?').get(rule.id)).toEqual(disabled);
  }
  expect(()=>saveRule({id:712,is_admin:false},{enabled:true},rule.id)).toThrow(/AI_NOT_FOUND/);
  expect(()=>saveRule(actor,{enabled:'true'},rule.id)).toThrow(/AI_INVALID_RULE/);
  expect(()=>saveRule(actor,input)).toThrow(/AI_NOT_FOUND/);

  expect(saveRule(actor,{name:'Retained cleanup',enabled:true},rule.id)).toMatchObject({name:'Retained cleanup',enabled:true,preview:[{user_channel_id:1112,before:'DE | Sport',after:'Sport'}]});
  expect(applyRulesAfterSync(711,[912])).toEqual({applied:1});
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1112').get().custom_name).toBe('Sport');
});
it('requires an applied rename when updating a rule transformation',()=>{
  const first=rename();
  applyProposal(actor,first.id,{action_ids:[first.actions[0].id],idempotency_key:'initial-rule'});
  const rule=saveRule(actor,{proposal_id:first.id,action_id:first.actions[0].id,name:'Cleanup',operation:'strip_prefix',match:'DE | '});
  const second=createProposal(actor,payload,[{type:'rename_channel',user_channel_id:1112,value:'Sports'}],'Update cleanup');
  const update={proposal_id:second.id,action_id:second.actions[0].id,operation:'replace_literal',match:'DE | Sport',replacement:'Sports'};
  expect(()=>saveRule(actor,update,rule.id)).toThrow(/AI_RULE_REQUIRES_CONFIRMATION/);
  expect(listRules(actor)[0]).toMatchObject({operation:'strip_prefix',match:'DE | '});
  applyProposal(actor,second.id,{action_ids:[second.actions[0].id],idempotency_key:'updated-rule'});
  saveRule(actor,update,rule.id);
  expect(listRules(actor)[0]).toMatchObject({id:rule.id,operation:'replace_literal',match:'DE | Sport',replacement:'Sports'});
});
it.each([
  ['an occupied destination',[{type:'reorder_channel',user_channel_id:1111,value:1}]],
  ['duplicate requested destinations',[{type:'reorder_channel',user_channel_id:1111,value:2},{type:'reorder_channel',user_channel_id:1112,value:2}]],
  ['an assignment destination',[{type:'assign_channel',provider_channel_id:911,category_id:1011},{type:'reorder_channel',user_channel_id:1112,value:2}]]
])('atomically rejects reorder actions with %s',(_case,actions)=>{
  const proposal=createProposal(actor,{...payload,feature:'list'},actions,'Reorder');
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'conflicting-order'})).toThrow(/AI_REORDER_CONFLICT/);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT status FROM ai_proposals WHERE id=?').get(proposal.id).status).toBe('pending');
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
});
it('requires companion reorder moves and atomically applies and undoes a complete swap',()=>{
  const proposal=createProposal(actor,payload,[{type:'reorder_channel',user_channel_id:1111,value:1},{type:'reorder_channel',user_channel_id:1112,value:0}],'Swap');
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(proposal.actions.map(action=>action.after.sort_order)).toEqual([1,0]);
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'partial-swap'})).toThrow(/AI_REORDER_CONFLICT/);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  const selection={action_ids:proposal.actions.map(action=>action.id),idempotency_key:'complete-swap'};
  const applied=applyProposal(actor,proposal.id,selection);
  expect(applyProposal(actor,proposal.id,selection)).toEqual(applied);
  expect(db.prepare('SELECT id FROM user_channels WHERE user_category_id=1011 ORDER BY sort_order').all()).toEqual([{id:1112},{id:1111}]);
  expect(undoChange(actor,applied.change_id).status).toBe('undone');
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
});
it('rejects a reorder destination occupied after the preview without overwriting the later edit',()=>{
  const proposal=createProposal(actor,payload,[{type:'reorder_channel',user_channel_id:1111,value:2}],'Move');
  db.prepare('UPDATE user_channels SET sort_order=2 WHERE id=1112').run();
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(()=>applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'late-occupant'})).toThrow(/AI_REORDER_CONFLICT/);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ai_changes').get().n).toBe(0);
});
it('rejects reorder undo when another entry has since occupied the original position',()=>{
  const proposal=createProposal(actor,payload,[{type:'reorder_channel',user_channel_id:1111,value:2}],'Move');
  const applied=applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'undo-occupied'});
  db.prepare('UPDATE user_channels SET sort_order=0 WHERE id=1112').run();
  const before=db.prepare('SELECT * FROM user_channels ORDER BY id').all();
  expect(()=>undoChange(actor,applied.change_id)).toThrow(/AI_UNDO_CONFLICT/);
  expect(db.prepare('SELECT * FROM user_channels ORDER BY id').all()).toEqual(before);
  expect(db.prepare('SELECT status FROM ai_changes WHERE id=?').get(applied.change_id).status).toBe('applied');
});
it('preserves pinned positions and region variants unless explicitly selected',()=>{
  expect(()=>createProposal(actor,{...payload,pinned_ids:[1111]},[{type:'reorder_channel',user_channel_id:1111,value:5}],'')).toThrow(/AI_PROTECTED_VALUE/);
  expect(()=>createProposal(actor,{...payload,keep_first:1},[{type:'rename_channel',user_channel_id:1111,value:'News'}],'')).toThrow(/AI_PROTECTED_VALUE/);
  expect(()=>createProposal(actor,{...payload,pinned_ids:[1111]},[{type:'reorder_channel',user_channel_id:1112,value:0}],'')).toThrow(/AI_PROTECTED_VALUE/);
  expect(()=>createProposal(actor,{...payload,feature:'duplicates'},[{type:'hide_channel',user_channel_id:1112,value:true}],'')).toThrow(/AI_REGIONAL_VARIANT_PROTECTED/);
  const proposal=createProposal(actor,{...payload,feature:'duplicates',selected_ids:[1112]},[{type:'hide_channel',user_channel_id:1112,value:true}],'');
  const result=applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'hide'});
  expect(db.prepare('SELECT is_hidden FROM user_channels WHERE id=1112').get().is_hidden).toBe(1);
  db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1112').run();
  expect(()=>undoChange(actor,result.change_id)).toThrow();
});
it('never implicitly hides every member of a duplicate group',()=>{
  db.prepare("UPDATE provider_channels SET name='DE | News HD' WHERE id=912").run();
  expect(()=>createProposal(actor,{...payload,feature:'duplicates'},[
    {type:'hide_channel',user_channel_id:1111,value:true},{type:'hide_channel',user_channel_id:1112,value:true}],'')).toThrow(/AI_DUPLICATE_SURVIVOR_REQUIRED/);
});
it('does not authorize another user catalog merely because the actor is admin',()=>{
  const admin={id:711,is_admin:true};
  expect(()=>createProposal(admin,{...payload,feature:'list'},[{type:'assign_channel',provider_channel_id:913,category_id:1011}],'')).toThrow(/AI_FORBIDDEN/);
});
it('rechecks all summarized evidence after apply and after undo',async()=>{
  const {buildContext}=await import('../src/services/ai/context.js');
  const proposal=createProposal(actor,payload,[{type:'rename_channel',user_channel_id:1111,value:'News'}],'News and Sport reviewed',buildContext(actor,payload).refs);
  const applied=applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'summary'});
  expect(getProposal(actor,proposal.id).summary).toContain('Sport');
  db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1112').run();
  expect(()=>getProposal(actor,proposal.id)).toThrow();
  db.prepare('UPDATE user_channels SET authorization_revoked=0 WHERE id=1112').run();
  undoChange(actor,applied.change_id);
  db.prepare('UPDATE user_channels SET authorization_revoked=1 WHERE id=1112').run();
  expect(()=>getProposal(actor,proposal.id)).toThrow();
});
it('undoes overlapping assign and reorder actions using their execution-time values',()=>{
  const proposal=createProposal(actor,{...payload,feature:'list'},[
    {type:'assign_channel',provider_channel_id:911,category_id:1011},
    {type:'reorder_channel',user_channel_id:1111,value:10}],'Assign and reorder');
  const applied=applyProposal(actor,proposal.id,{action_ids:proposal.actions.map(action=>action.id),idempotency_key:'overlap'});
  expect(undoChange(actor,applied.change_id).status).toBe('undone');
  expect(db.prepare('SELECT sort_order,assignment_origin,mapping_id FROM user_channels WHERE id=1111').get()).toEqual({sort_order:0,assignment_origin:'mapping',mapping_id:99});
});
it('lists owned rule changes and restores an original null custom name on undo',()=>{
  const proposal=rename();
  applyProposal(actor,proposal.id,{action_ids:[proposal.actions[0].id],idempotency_key:'rule-null'});
  const rule=saveRule(actor,{proposal_id:proposal.id,action_id:proposal.actions[0].id,name:'Strip DE',operation:'strip_prefix',match:'DE | ',replacement:'',enabled:true});
  db.prepare('UPDATE user_channels SET custom_name=NULL WHERE id=1112').run();
  expect(applyRulesAfterSync(711,[912]).applied).toBe(1);
  const history=listChanges(actor);
  const applied=history.find(change=>change.rule_id===rule.id);
  expect(applied).toMatchObject({user_id:711,feature:'cleanup',status:'applied'});
  expect(applied.diffs).toBeUndefined();
  expect(listChanges({id:712,is_admin:false})).toEqual([]);
  expect(()=>listChanges(actor,712)).toThrow();
  expect(getChange(actor,applied.id).diffs[0].before).toEqual({custom_name:null});
  undoChange(actor,applied.id);
  expect(db.prepare('SELECT custom_name FROM user_channels WHERE id=1112').get().custom_name).toBeNull();
});
