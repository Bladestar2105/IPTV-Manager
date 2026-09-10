import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from 'playwright';

// Synthetic UI contract check: no database, credentials or live model requests.
const app = express();
const startedAt = performance.now();
app.use(express.static('public'));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.on('listening', resolve));
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const features = ['list', 'cleanup', 'duplicates', 'epg', 'sync', 'search', 'diagnose', 'text'];
  let settings = {enabled: false, allow_own_connections: true, allowed_user_ids: [2], functions: features, internal_targets: []};
  let preferences = {enabled: false, connection_id: null, model_id: null};
  let connections = [], discoverFails = false, jobCount = 0, pollCount = 0, cancelNext = false;
  let cancelGate;
  let releaseChangeA, changeARequested, delayChangeA = true, releaseUndoA, undoARequested, delayUndoA = false;
  const waitForChangeA = new Promise(resolve => { changeARequested = resolve; });
  const waitForUndoA = new Promise(resolve => { undoARequested = resolve; });
  let delayPrograms = false, releasePrograms, programsRequested;
  const waitForPrograms = new Promise(resolve => { programsRequested = resolve; });
  const programReference = {channel_id: 'real-epg-channel', source_type: 'xmltv', source_id: 7, start: 1800000000};
  const requests = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/ai', '');
    const method = request.method(), body = request.postDataJSON();
    requests.push({path, method, body});
    let data = {}, status = 200;
    if (path === '/settings') { if (method === 'PUT') settings = body; data = settings; }
    else if (path === '/preferences') { if (method === 'PUT') preferences = {...preferences, ...body}; data = preferences; }
    else if (path === '/connections') {
      if (method === 'POST') { const {api_key, ...safe} = body; connections.push({...safe, id: 'c1', editable: true, has_key: Boolean(api_key), models: [], capabilities: {}}); data = connections[0]; }
      else data = connections;
    } else if (path === '/connections/c1') {
      if (method === 'PUT') { const {api_key: _key, ...safe} = body; connections[0] = {...connections[0], ...safe}; data = connections[0]; }
      else if (method === 'DELETE') connections = [];
    } else if (path.endsWith('/discover')) {
      if (discoverFails) { status = 502; data = {code: 'AI_UNAVAILABLE'}; }
      else data = {models: [{id: 'chat-one'}, {id: 'chat-two'}]};
    } else if (path.endsWith('/test')) {
      assert(settings.enabled && preferences.enabled, 'tests require explicit activation');
      assert(!body.model_ids.includes(undefined));
      const models = body.model_ids.map(id => ({id, chat: true, structured: true, status: 'compatible'}));
      connections[0].capabilities = Object.fromEntries(models.map(model => [model.id, model]));
      data = {models, recommended_model_id: body.model_ids[0]};
    } else if (/^\/channels\/\d+\/programs$/.test(path)) {
      if (delayPrograms) { programsRequested(); await new Promise(resolve => { releasePrograms = resolve; }); }
      data = {items: [{provider_channel_id: Number(path.split('/')[2]), title: 'Actual program', description: '<b>Original EPG description</b>', start: 1800000000, stop: 1800003600, local_start: '2027-01-15 20:00', timezone: 'Europe/Berlin', program: programReference}], truncated: false};
    } else if (path === '/jobs' && method === 'POST') { jobCount++; pollCount = 0; data = {id: `j${jobCount}`, status: 'queued'}; }
    else if (/^\/jobs\/j\d+$/.test(path)) {
      pollCount++;
      data = {id: `j${jobCount}`, status: cancelNext || pollCount === 1 ? 'running' : 'completed', result: {feature: 'list', summary: '<img src=x onerror="window.hostile=true">', proposal_id: 'p1', conversation_id: 'search1', filters: {query: 'news', language: 'en'}, coverage: {processed: 2000, total: 2000, partial: false, items_shown: 20, items_total: 2000}}};
    } else if (path.endsWith('/cancel')) {
      if (cancelGate?.path === path) {
        const gate = cancelGate;
        gate.started();
        await new Promise(resolve => { gate.release = resolve; });
        status = gate.status;
      }
      data = status === 200 ? {status: 'cancelled'} : {code: 'AI_UNAVAILABLE'};
    }
    else if (path === '/proposals/p1') data = {id: 'p1', summary: 'Review', actions: [{id: 'a0', label: 'Create category', type: 'create_category', before: null, after: {name: 'News'}}, {id: 'a1', label: '<script>window.hostile=true</script>', type: 'rename_channel', dependencies: ['a0'], before: {name: 'old'}, after: {name: 'new'}}, {id: 'a2', label: 'Second rename', type: 'rename_channel', before: {name: 'second old'}, after: {name: 'second new'}}]};
    else if (path.endsWith('/apply')) { assert.deepEqual(body.action_ids.slice(0, 2), ['a0', 'a1']); assert(body.idempotency_key.length <= 200); data = {change_id: 'change1', status: 'applied'}; }
    else if (/^\/jobs\/history/.test(path)) {
      const id = path.split('/').at(-1);
      data = {id, status: 'completed', result: id === 'historyRead' ? {feature: 'diagnose', summary: 'Read-only result'} : {feature: 'list', summary: id, proposal_id: id}};
    }
    else if (/^\/proposals\/history/.test(path)) {
      const id = path.split('/').at(-1);
      data = {id, status: 'applied', summary: `Proposal ${id}`, change_id: id.replace('history', 'change'), actions: []};
    }
    else if (/^\/changes\/change[AB]$/.test(path)) {
      if (path.endsWith('changeA') && delayChangeA) { delayChangeA = false; changeARequested(); await new Promise(resolve => { releaseChangeA = resolve; }); }
      data = {id: path.split('/').at(-1), status: 'applied', action_ids: []};
    }
    else if (path === '/changes') data = [{id: 'ruleChange', user_id: 2, feature: 'cleanup', status: 'applied', created_at: Date.now(), rule_id: 'r1'}];
    else if (path === '/changes/ruleChange') data = {id: 'ruleChange', status: 'applied', action_ids: [], diffs: [{id: 5, before: {custom_name: null}, after: {custom_name: 'Rule-generated name'}}]};
    else if (path.endsWith('/undo')) {
      if (path === '/changes/changeA/undo' && delayUndoA) { undoARequested(); await new Promise(resolve => { releaseUndoA = resolve; }); }
      data = {status: 'undone'};
    }
    else if (path === '/rules') data = method === 'GET' ? [] : {id: 'r1', ...body, preview: [{before: 'old', after: 'new'}]};
    else if (path === '/rules/r1') data = {id: 'r1', ...body, preview: [{before: 'old', after: 'new'}]};
    else if (path === '/jobs') data = [{id: 'historyA', feature: 'list'}, {id: 'historyB', feature: 'list'}, {id: 'historyRead', feature: 'diagnose'}];
    else if (path === '/usage') data = {prompt_tokens: null};
    else if (path === '/history') data = {deleted: true};
    else if (!url.pathname.startsWith('/api/ai')) data = [];
    else { status = 404; data = {code: 'AI_NOT_FOUND'}; }
    await route.fulfill({status, contentType: 'application/json', body: JSON.stringify(data)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addStyleTag({content: '.modal, .modal-backdrop { display: none !important; }'});
  assert.equal(await page.evaluate(() => typeof window.aiUI), 'object', 'AI UI must be integrated');
  await page.evaluate(() => {
    currentUser = {id: 1, is_admin: true};
    document.querySelectorAll('.modal-backdrop').forEach(item => item.remove());
    document.getElementById('login-modal').remove();
    document.getElementById('main-content').classList.remove('d-none');
    document.getElementById('main-navbar').classList.remove('d-none');
    switchView('ai');
  });
  await page.locator('#ai-connection').waitFor();
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'opening never contacts a model');
  await page.locator('details').filter({has: page.locator('#ai-policy-enabled')}).locator('summary').click();
  await page.locator('#ai-policy-enabled').check();
  await page.locator('#ai-save-policy').click();
  await page.locator('#ai-connection').waitFor();
  await page.locator('#ai-enabled').check();
  await page.locator('#ai-connection').selectOption('new');
  await page.locator('#ai-name').fill('My AI');
  await page.locator('#ai-url').fill('https://model.example/custom/v1');
  await page.locator('#ai-key').fill('synthetic-secret');
  assert.match(await page.locator('#ai-destination').innerText(), /model.example\/custom\/v1/);
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'typing has no discovery side effects');
  await page.locator('#ai-enabled').uncheck();
  await page.locator('#ai-discover').click();
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'disabled preference forbids model discovery');
  await page.locator('#ai-enabled').check();
  await page.locator('#ai-discover').click();
  await page.locator('#ai-models option').first().waitFor();
  assert.equal(await page.locator('#ai-key').inputValue(), '', 'key cleared after save');
  await page.locator('#ai-models').selectOption(['chat-one']);
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-model').value === 'chat-one');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/ai/preferences') && response.request().postDataJSON()?.model_id === 'chat-one'),
    page.locator('#ai-finish').click()
  ]);
  assert.equal(preferences.model_id, 'chat-one', 'wizard works without typing a model ID');
  assert.equal(preferences.enabled, true);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(item => item.includes('synthetic-secret'))), false);
  discoverFails = true;
  await page.locator('#ai-discover').click();
  await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_network');
  await page.locator('summary[data-i18n="ai_advanced"]').click();
  await page.locator('#ai-model').fill('manual-alias');
  await page.locator('#ai-models').selectOption([]);
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-capabilities').textContent.includes('manual-alias'));
  assert.equal(requests.filter(r => r.path.endsWith('/test')).at(-1).body.model_ids[0], 'manual-alias');
  await page.locator('#ai-user').fill('2');
  await page.locator('#ai-prompt').fill('Review my list');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  assert.equal(await page.locator('#ai-result img').count(), 0);
  assert.equal(await page.locator('#ai-proposal script').count(), 0);
  assert.equal(await page.evaluate(() => window.hostile), undefined);
  assert.match(await page.locator('#ai-result').innerText(), /Analyzed items: 2000 \/ 2000/);
  assert.match(await page.locator('#ai-result').innerText(), /Displayed item examples: 20 \/ 2000/);
  assert.equal(await page.locator('#ai-action-a1').isChecked(), false, 'changes never preselected');
  await page.locator('#ai-action-a1').check();
  await page.locator('#ai-apply').click();
  await page.locator('#ai-undo').waitFor();
  assert.deepEqual(await page.locator('#ai-rule-action option').evaluateAll(options => options.map(option => option.value)), ['a1'], 'only actually applied renames can source a rule');
  await page.locator('summary[data-i18n="ai_rules"]').click();
  await page.locator('#ai-rule-name').fill('My cleanup');
  await page.locator('#ai-rule-match').fill('old');
  await page.locator('#ai-rule-exceptions').fill('Regional,HD');
  assert.equal(await page.locator('#ai-rule-enabled').isChecked(), false, 'future automation defaults off');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/rules') && response.request().method() === 'POST'), page.locator('#ai-rule-preview').click()]);
  await page.waitForFunction(() => document.getElementById('ai-rule-preview-result').textContent.includes('before'));
  assert.match(await page.locator('#ai-rule-preview-result').innerText(), /before/);
  assert.equal(requests.find(r => r.path === '/rules' && r.method === 'POST').body.enabled, false);
  assert.equal(requests.find(r => r.path === '/rules' && r.method === 'POST').body.action_id, 'a1', 'rule uses confirmed rename, not its checked category dependency');
  await page.locator('#ai-rule-enabled').check();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/rules/r1') && response.request().method() === 'PUT'), page.locator('#ai-save-rule').click()]);
  assert.equal(requests.find(r => r.path === '/rules/r1' && r.method === 'PUT').body.enabled, true);
  assert.deepEqual(requests.find(r => r.path === '/rules' && r.method === 'POST').body.exceptions, ['Regional', 'HD']);
  await page.locator('#ai-undo').click();
  await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_undone');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  await page.locator('#ai-action-a1').check();
  await page.locator('#ai-action-a2').check();
  await page.locator('#ai-apply').click();
  await page.locator('#ai-undo').waitFor();
  assert.deepEqual(await page.locator('#ai-rule-action option').evaluateAll(options => options.map(option => option.value)), ['', 'a1', 'a2']);
  assert.equal(await page.locator('#ai-rule-action').inputValue(), '', 'multiple applied renames require an explicit choice');
  await page.locator('#ai-rule-action').selectOption('a2');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/rules') && response.request().method() === 'POST'), page.locator('#ai-rule-preview').click()]);
  assert.equal(requests.filter(r => r.path === '/rules' && r.method === 'POST').at(-1).body.action_id, 'a2');
  for (const [lang, title] of [['de', 'KI-Assistent'], ['fr', 'Assistant IA'], ['el', 'Βοηθός AI'], ['en', 'AI assistant']]) {
    await page.locator('#language-selector').selectOption(lang);
    assert.equal(await page.locator('#view-ai h2').innerText(), title);
    assert.equal(await page.locator('#ai-feature option').count(), 8);
  }
  await page.locator('summary[data-i18n="ai_scope"]').click();
  await page.locator('#ai-channel-ids').fill('5,6');
  await page.locator('#ai-pinned').fill('6');
  await page.locator('#ai-keep-first').fill('1');
  for (const feature of ['cleanup', 'duplicates', 'epg', 'sync', 'diagnose', 'text']) {
    await page.locator('#ai-feature').selectOption(feature);
    await page.locator('#ai-run').click();
    await page.locator('#ai-action-a1').waitFor();
    const input = requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body;
    assert.equal(input.feature, feature);
    assert.deepEqual(input.pinned_ids, [6]);
    assert.equal(input.keep_first, 1);
    if (feature === 'text') { assert.equal(input.provider_channel_id, 5); assert.equal(input.operation, 'translate'); }
  }
  await page.locator('#ai-feature').selectOption('search');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  await page.locator('#ai-prompt').fill('Only in German');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  assert.equal(requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body.conversation_id, 'search1');
  assert.deepEqual(requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body.filters || {}, {}, 'unchanged filters cannot override natural-language follow-up');
  await page.locator('#ai-filters').fill('{"language":"de","genre":"documentary"}');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  assert.deepEqual(requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body.filters, {language: 'de', genre: 'documentary', query: null}, 'explicit filter edits and deletions are sent as a patch');
  await page.locator('#ai-new-search').click();
  assert.equal(await page.locator('#ai-filters').inputValue(), '{}');
  cancelNext = true;
  await page.locator('#ai-run').click();
  await page.locator('#ai-cancel').click();
  const resetSearch = requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body;
  assert.equal(resetSearch.conversation_id, undefined);
  assert.deepEqual(resetSearch.filters, {});
  await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_cancelled');
  for (const cancelStatus of [200, 502]) {
    await page.locator('#ai-feature').selectOption('list');
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_running');
    let cancelStarted;
    const started = new Promise(resolve => { cancelStarted = resolve; });
    cancelGate = {path: `/jobs/j${jobCount}/cancel`, status: cancelStatus, started: cancelStarted};
    await page.locator('#ai-cancel').click();
    await started;
    await page.locator('#ai-feature').selectOption('duplicates');
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_running');
    const newJobPath = `/jobs/j${jobCount}`;
    await Promise.all([page.waitForResponse(response => response.url().endsWith(cancelGate.path)), Promise.resolve().then(() => cancelGate.release())]);
    await page.waitForFunction(() => !document.getElementById('ai-cancel').disabled);
    assert.equal(await page.locator('#ai-status').getAttribute('data-i18n'), 'ai_running', `late cancel ${cancelStatus} cannot replace newer running-job status`);
    const pollsBefore = requests.filter(request => request.path === newJobPath && request.method === 'GET').length;
    await page.waitForResponse(response => response.url().endsWith(newJobPath) && response.request().method() === 'GET');
    assert(requests.filter(request => request.path === newJobPath && request.method === 'GET').length > pollsBefore, `new job keeps polling after late cancel ${cancelStatus}`);
    cancelGate = null;
    await page.locator('#ai-cancel').click();
    await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_cancelled');
  }
  await page.locator('details').filter({has: page.locator('#ai-clear-history')}).locator('summary').click();
  await page.locator('#ai-clear-history').click();
  await page.waitForFunction(() => document.getElementById('ai-status').dataset.i18n === 'ai_saved');
  assert(requests.some(r => r.path === '/history' && r.method === 'DELETE'));
  await page.locator('#ai-refresh-history').click();
  await page.locator('#ai-history-historyA').waitFor();
  await page.locator('#ai-history-historyA').click();
  await waitForChangeA;
  await page.locator('#ai-history-historyB').click();
  await page.locator('#ai-undo').waitFor();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/changes/changeA')), Promise.resolve().then(() => releaseChangeA())]);
  await page.waitForFunction(() => !document.getElementById('ai-history-historyA').disabled);
  assert.equal(await page.locator('#ai-undo').count(), 1, 'late history cannot append another Undo');
  assert.match(await page.locator('#ai-proposal').innerText(), /Proposal historyB/);
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/undo')), page.locator('#ai-undo').click()]);
  assert.equal(requests.filter(r => r.path.endsWith('/undo')).at(-1).path, '/changes/changeB/undo', 'late change A cannot redirect visible B Undo');
  await page.locator('#ai-history-historyA').click();
  await page.locator('#ai-undo').waitFor();
  delayUndoA = true;
  await page.locator('#ai-undo').click();
  await waitForUndoA;
  await page.locator('#ai-history-historyB').click();
  await page.locator('#ai-undo').waitFor();
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/changes/changeA/undo')), Promise.resolve().then(() => releaseUndoA())]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#ai-undo').isVisible(), true, 'late Undo A cannot hide Undo B');
  assert.match(await page.locator('#ai-proposal').innerText(), /Proposal historyB/);
  await page.locator('#ai-history-historyRead').click();
  await page.waitForFunction(() => document.getElementById('ai-result').textContent.includes('Read-only result'));
  assert.equal(await page.locator('#ai-proposal').innerText(), '', 'read-only result removes earlier actionable proposal');
  await page.locator('#ai-change-ruleChange').click();
  await page.locator('#ai-undo').waitFor();
  assert.match(await page.locator('#ai-result').innerText(), /Rule-generated name/);
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/changes/ruleChange/undo')), page.locator('#ai-undo').click()]);
  assert.equal(requests.filter(r => r.path.endsWith('/undo')).at(-1).path, '/changes/ruleChange/undo', 'automatic rule change can be inspected and undone without a job');
  cancelNext = false;
  await page.locator('#ai-feature').selectOption('text');
  await page.locator('#ai-text-source').selectOption('epg');
  const modelRequestsBeforePrograms = requests.filter(r => r.path === '/jobs' && r.method === 'POST').length;
  await page.locator('#ai-load-programs').click();
  await page.locator('#ai-program option[value="0"]').waitFor({state: 'attached'});
  assert.equal(requests.filter(r => r.path === '/jobs' && r.method === 'POST').length, modelRequestsBeforePrograms, 'program loading is local and does not start inference');
  await page.locator('#ai-program').selectOption('0');
  assert.equal(await page.locator('#ai-program-description b').count(), 0, 'program descriptions are plain text');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  assert.deepEqual(requests.filter(r => r.path === '/jobs' && r.method === 'POST').at(-1).body.program, programReference, 'text job sends the selected factual EPG reference');
  await page.locator('#ai-channel-ids').fill('6');
  assert.equal(await page.locator('#ai-program option').count(), 1, 'channel change clears EPG choices');
  delayPrograms = true;
  await page.locator('#ai-load-programs').click();
  await waitForPrograms;
  await page.locator('#ai-channel-ids').fill('7');
  await Promise.all([page.waitForResponse(response => response.url().includes('/channels/6/programs')), Promise.resolve().then(() => releasePrograms())]);
  await page.waitForFunction(() => !document.getElementById('ai-load-programs').disabled);
  assert.equal(await page.locator('#ai-program option').count(), 1, 'late EPG response cannot populate a different channel');
  delayPrograms = false;
  await page.locator('#ai-load-programs').click();
  await page.locator('#ai-program option[value="0"]').waitFor({state: 'attached'});
  await page.locator('#ai-program').selectOption('0');
  await page.locator('#ai-user').fill('3');
  assert.equal(await page.locator('#ai-program option').count(), 1, 'target-user change clears EPG references');
  assert.equal(await page.locator('#ai-program-description').innerText(), '');
  if (process.env.AI_UI_SCREENSHOT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: process.env.AI_UI_SCREENSHOT});
  }
  connections[0] = {...connections[0], shared: true, editable: false, model_id: 'chat-one'};
  preferences.connection_id = 'c1';
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 2, is_admin: false}; await aiUI.open(); });
  assert.equal(await page.locator('#ai-key').count(), 0, 'borrowed setup never asks for keys');
  assert.equal(await page.locator('#ai-model').getAttribute('readonly'), '');
  assert.equal(await page.locator('#ai-model-controls').isVisible(), false, 'borrowed connection cannot be tested or changed');
  await page.evaluate(() => aiUI.clear());
  assert.equal(await page.locator('#view-ai').innerText(), '', 'logout cleanup removes all AI state');
  await page.evaluate(() => {
    const original = fetchJSON;
    fetchJSON = url => url === '/api/ai/settings' ? new Promise(resolve => { window.releaseAiSettings = () => resolve({enabled: true}); }) : original(url);
    window.pendingAiOpen = aiUI.open();
  });
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 3, is_admin: false}; window.releaseAiSettings(); await window.pendingAiOpen; });
  assert.equal(await page.locator('#view-ai').innerText(), '', 'late prior-user response cannot repopulate UI');
  console.log(`PASS AI UI (${Math.round(performance.now() - startedAt)} ms): setup and all eight functions; confirmed rename rules; follow-up filter patches; delayed history/Undo isolation; read-only cleanup; automatic rule-change history/Undo; local EPG picker and stale-target isolation; analyzed/displayed counts; four languages; session isolation. Synthetic API only.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
