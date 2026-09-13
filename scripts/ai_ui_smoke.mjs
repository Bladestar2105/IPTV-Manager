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
  let settings = {enabled: false, allow_own_connections: true, allowed_user_ids: [2, 99], functions: features, internal_targets: []};
  let preferences = {enabled: false, connection_id: null, model_id: null};
  let connections = [], discoverFails = false, jobCount = 0, pollCount = 0, cancelNext = false, nextJobError = null, cancelResult = 'cancelled', pollErrorOnce = false;
  let discoverError = {status: 502, code: 'AI_UNAVAILABLE'};
  let nextJobResult = null;
  let discoveredModels = [{id: 'chat-one'}, {id: 'chat-two'}, {id: 'chat-three'}, {id: 'chat-four'}];
  let cancelGate, releaseJobCreation, jobCreationRequested;
  let delayJobCreation = true;
  const waitForJobCreation = new Promise(resolve => { jobCreationRequested = resolve; });
  let releaseChangeA, changeARequested, delayChangeA = true, releaseUndoA, undoARequested, delayUndoA = false;
  const waitForChangeA = new Promise(resolve => { changeARequested = resolve; });
  const waitForUndoA = new Promise(resolve => { undoARequested = resolve; });
  let delayPrograms = false, releasePrograms, programsRequested;
  const waitForPrograms = new Promise(resolve => { programsRequested = resolve; });
  const programReference = {channel_id: 'real-epg-channel', source_type: 'xmltv', source_id: 7, start: 1800000000};
  // Personal ChatGPT account-link state for the synthetic server.
  let codexAvailable = false, loginState = null, verificationUrl = 'https://auth.openai.com/codex/device';
  let chatgptAccount = {linked: false, label: null, plan_type: null, auth_method: null}, accountReadsLinked = true, failNextPolls = 0;
  let policyGate, linkGate, failLinkCancel = false, missingLink = false;
  const requests = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/ai', '');
    const method = request.method(), body = request.postDataJSON();
    requests.push({path, method, body});
    let data = {}, status = 200;
    if (url.pathname === '/api/users') data = [{id: 2, username: 'Library owner', plain_password: 'not-for-ai'}, {id: 3, username: '<b>Second library</b>'}];
    else if (path === '/settings') {
      if (method === 'PUT') {
        if (policyGate) { policyGate.started(); await new Promise(resolve => { policyGate.release = resolve; }); }
        settings = body;
      }
      data = settings;
    }
    else if (path === '/preferences') { if (method === 'PUT') preferences = {...preferences, ...body}; data = preferences; }
    else if (path === '/connections') {
      if (method === 'POST') {
        const {api_key, ...safe} = body;
        const chatgpt = safe.provider === 'chatgpt_account';
        connections.push({...safe, id: chatgpt ? 'c2' : 'c1', editable: true, has_key: chatgpt ? false : Boolean(api_key),
          models: [], capabilities: {}, ...(chatgpt ? {base_url: null, account: chatgptAccount} : {})});
        data = connections.at(-1);
      }
      else data = connections;
    }
    else if (path === '/codex/status') data = codexAvailable
      ? {available: true, reason: null, codex_version: '0.154.0', isolation: {backend: 'bwrap', grade: 'isolated'}}
      : {available: false, reason: 'AI_CODEX_DISABLED', codex_version: null, isolation: null};
    else if (path.startsWith('/connections/c2')) {
      const stored = () => connections.find(item => item.id === 'c2');
      const rest = path.slice('/connections/c2'.length);
      if (rest === '' && method === 'PUT') { const {api_key: _chatgptKey, ...safe} = body; Object.assign(stored(), safe); data = stored(); }
      else if (rest === '/link' && method === 'POST') {
        if (linkGate) { linkGate.started(); await new Promise(resolve => { linkGate.release = resolve; }); }
        loginState = {id: 'L1', status: 'pending', verification_url: verificationUrl, user_code: 'ABCD-1234', error_code: null, expires_at: Date.now() + 900000};
        data = loginState;
      }
      else if (rest === '/link/L1') {
        if (missingLink) { missingLink = false; status = 404; data = {code: 'AI_NOT_FOUND'}; }
        else if (failNextPolls > 0) { failNextPolls -= 1; status = 502; data = {code: 'AI_UNAVAILABLE'}; }
        else data = loginState;
      }
      else if (rest === '/link/L1/cancel') {
        if (failLinkCancel) { failLinkCancel = false; status = 502; data = {code: 'AI_UNAVAILABLE'}; }
        else { loginState = {...loginState, status: 'cancelled', error_code: 'ai_codex_login_cancelled'}; data = loginState; }
      }
      else if (rest === '/unlink') {
        chatgptAccount = {linked: false, label: null, plan_type: null, auth_method: null};
        Object.assign(stored(), {account: chatgptAccount});
        data = {disconnected: true, remote_logout: true};
      }
      else if (rest === '/account') data = accountReadsLinked
        ? {...chatgptAccount, quota: {known: true, ordinary_usage_allowed: true, primary: {used_percent: 42, window_minutes: 300, resets_at: 1800000000}, secondary: null}}
        : {linked: false, label: null, plan_type: null, auth_method: null, quota: {known: false}};
      else { status = 404; data = {code: 'AI_NOT_FOUND'}; }
    }
    else if (path === '/connections/c1') {
      if (method === 'PUT') { const {api_key: _key, ...safe} = body; connections[0] = {...connections[0], ...safe}; data = connections[0]; }
      else if (method === 'DELETE') connections = [];
    } else if (path.endsWith('/discover')) {
      if (discoverFails) { status = discoverError.status; data = {code: discoverError.code}; }
      else data = {models: discoveredModels};
    } else if (path.endsWith('/test')) {
      assert.equal(await page.locator('#ai-setup-status').getAttribute('data-i18n'), 'ai_running', 'model tests show local progress before the response');
      assert.equal(await page.locator('#ai-setup-progress .spinner-border').isVisible(), true);
      assert(settings.enabled && preferences.enabled, 'tests require explicit activation');
      assert(!body.model_ids.includes(undefined));
      const models = body.model_ids.map(id => ({id, chat: true, structured: true, status: 'compatible', token_parameter: id === 'chat-two' ? 'max_completion_tokens' : 'max_tokens'}));
      connections[0].capabilities = Object.fromEntries(models.map(model => [model.id, model]));
      data = {models, recommended_model_id: body.model_ids[0]};
    } else if (/^\/channels\/\d+\/programs$/.test(path)) {
      if (delayPrograms) { programsRequested(); await new Promise(resolve => { releasePrograms = resolve; }); }
      data = {items: [{provider_channel_id: Number(path.split('/')[2]), title: 'Actual program', description: '<b>Original EPG description</b>', start: 1800000000, stop: 1800003600, local_start: '2027-01-15 20:00', timezone: 'Europe/Berlin', program: programReference}], truncated: false};
    } else if (path === '/jobs' && method === 'POST') {
      assert.equal(Object.hasOwn(body, 'provider_id'), false, 'job requests must not send unsupported provider scope');
      if (delayJobCreation) { jobCreationRequested(); await new Promise(resolve => { releaseJobCreation = resolve; }); }
      jobCount++; pollCount = 0; data = {id: `j${jobCount}`, status: 'queued'};
    }
    else if (/^\/jobs\/j\d+$/.test(path)) {
      if (pollErrorOnce) { pollErrorOnce = false; await route.fulfill({status: 503, json: {code: 'AI_UNAVAILABLE'}}); return; }
      pollCount++;
      if (nextJobError && pollCount > 1) data = {id: `j${jobCount}`, status: 'failed', error_code: nextJobError};
      else data = {id: `j${jobCount}`, status: cancelNext || pollCount === 1 ? 'running' : 'completed', result: nextJobResult || {feature: 'list', summary: '<img src=x onerror="window.hostile=true">', proposal_id: 'p1', conversation_id: 'search1', filters: {query: 'news', language: 'en'}, coverage: {processed: 2000, total: 2000, partial: false, items_shown: 20, items_total: 2000}}};
    } else if (path.endsWith('/cancel')) {
      if (cancelGate?.path === path) {
        const gate = cancelGate;
        gate.started();
        await new Promise(resolve => { gate.release = resolve; });
        status = gate.status;
      }
      data = status === 200 ? {status: cancelResult} : {code: 'AI_UNAVAILABLE'};
    }
    else if (path === '/proposals/p1') data = {id: 'p1', summary: 'Review', actions: [{id: 'a0', label: 'Create category', type: 'create_category', before: null, after: {name: 'News'}}, {id: 'a1', label: '<script>window.hostile=true</script>', type: 'rename_channel', dependencies: ['a0'], before: {name: 'old'}, after: {name: 'new'}}, {id: 'a2', label: 'Second rename', type: 'rename_channel', before: {name: 'second old'}, after: {name: 'second new'}}]};
    else if (path.endsWith('/apply')) { assert.deepEqual(body.action_ids.slice(0, 2), ['a0', 'a1']); assert(body.idempotency_key.length <= 200); data = {change_id: 'change1', status: 'applied'}; }
    else if (/^\/jobs\/history/.test(path)) {
      const id = path.split('/').at(-1);
      data = {id, status: 'completed', result: id === 'historyRead' ? {feature: 'diagnose', summary: 'Read-only result', findings: [
        {code: 'local_user_connections', certainty: 'proven', value: {limit_reached: true}},
        {code: 'new_connection_may_be_blocked', certainty: 'possible'},
        {code: 'protocol_export_delivery', certainty: 'unknown', reason: 'not_measured'}
      ]} : {feature: 'list', summary: id, proposal_id: id}};
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
  assert.equal(await page.locator('#ai-user').evaluate(item => item.tagName), 'SELECT', 'library targets must be selected by name rather than typed IDs');
  assert.equal(await page.locator('#ai-user').inputValue(), '', 'opening must not silently select a target');
  assert.deepEqual(await page.locator('#ai-user option').allTextContents(), ['Choose…', '<b>Second library</b>', 'Library owner']);
  assert.equal(await page.locator('#ai-user b').count(), 0, 'usernames are plain text');
  assert.deepEqual(await page.locator('#ai-allowed-users').evaluate(select => [...select.selectedOptions].map(option => Number(option.value))), [2, 99], 'saved grants, including unavailable entries, must not silently disappear');
  assert.equal(await page.locator('#ai-provider-id').count(), 0, 'unsupported provider scope must not be offered');
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'opening never contacts a model');
  await page.locator('details').filter({has: page.locator('#ai-policy-enabled')}).locator('summary').click();
  await page.locator('#ai-policy-enabled').check();
  await page.locator('#ai-allowed-users').selectOption(['2', '3']);
  await page.locator('#ai-save-policy').click();
  await page.locator('#ai-connection').waitFor();
  assert.deepEqual(settings.allowed_user_ids, [3, 2], 'grant selections submit stable user IDs');
  await page.locator('#ai-enabled').check();
  await page.locator('#ai-connection').selectOption('new');
  await page.locator('#ai-connection-users').selectOption(['2', '3']);
  await page.locator('#ai-name').fill('My AI');
  await page.locator('#ai-url').fill('https://model.example/custom/v1');
  await page.locator('#ai-key').fill('synthetic-secret');
  assert.match(await page.locator('#ai-destination').innerText(), /model.example\/custom\/v1/);
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'typing has no discovery side effects');
  const beforeRejectedTest = JSON.stringify({settings, preferences, connections});
  const writesBeforeRejectedTest = requests.filter(request => ['POST', 'PUT', 'DELETE'].includes(request.method)).length;
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-setup-status').dataset.i18n === 'ai_modelTestSelection');
  assert.equal(await page.locator('#ai-status').isVisible(), false, 'section errors must not be mirrored at the page top');
  assert.equal(await page.locator('#ai-setup-progress').getAttribute('role'), 'status', 'local feedback remains accessible to screen readers');
  assert.equal(JSON.stringify({settings, preferences, connections}), beforeRejectedTest, 'invalid model choices must not enable preferences, save a connection or sharing grants');
  assert.equal(requests.filter(request => ['POST', 'PUT', 'DELETE'].includes(request.method)).length, writesBeforeRejectedTest, 'reject invalid model choices before any persistent request');
  assert.equal(await page.locator('#ai-key').inputValue(), 'synthetic-secret', 'rejected selection must leave the unsubmitted key in its field');

  await page.locator('#ai-enabled').uncheck();
  await page.locator('#ai-discover').click();
  assert.equal(requests.filter(r => /discover|test/.test(r.path)).length, 0, 'disabled preference forbids model discovery');
  await page.locator('#ai-enabled').check();
  await page.locator('#ai-discover').click();
  await page.locator('#ai-models option').first().waitFor();
  assert.equal(await page.locator('#ai-key').inputValue(), '', 'key cleared after save');
  assert.deepEqual(connections[0].allowed_user_ids, [3, 2], 'shared connection grants come from the named user selector');
  assert.deepEqual(await page.locator('#ai-models').evaluate(select => [...select.selectedOptions].map(option => option.value)), [], 'discovery order and model names do not imply compatibility');
  await page.locator('#ai-models').selectOption(['chat-one', 'chat-two', 'chat-three', 'chat-four']);
  await page.locator('#ai-key').fill('unsubmitted-replacement');
  const beforeTooManyModels = JSON.stringify({settings, preferences, connections});
  const writesBeforeTooManyModels = requests.filter(request => ['POST', 'PUT', 'DELETE'].includes(request.method)).length;
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-setup-status').dataset.i18n === 'ai_modelTestSelection');
  assert.equal(JSON.stringify({settings, preferences, connections}), beforeTooManyModels);
  assert.equal(requests.filter(request => ['POST', 'PUT', 'DELETE'].includes(request.method)).length, writesBeforeTooManyModels, 'too many candidates must not update an existing connection');
  assert.equal(await page.locator('#ai-key').inputValue(), 'unsubmitted-replacement');
  await page.locator('#ai-key').fill('');
  await page.locator('#ai-models').selectOption([]);
  discoveredModels = [{id: 'chat-one'}];
  await page.locator('#ai-discover').click();
  await page.waitForFunction(() => document.getElementById('ai-models').options.length === 1);
  assert.deepEqual(await page.locator('#ai-models').evaluate(select => [...select.selectedOptions].map(option => option.value)), ['chat-one'], 'a sole candidate can be tested without typing its ID');
  await page.locator('#ai-models').selectOption(['chat-one']);
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-model').value === 'chat-one');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/ai/preferences') && response.request().postDataJSON()?.model_id === 'chat-one'),
    page.locator('#ai-finish').click()
  ]);
  assert.equal(preferences.model_id, 'chat-one', 'wizard works without typing a model ID');
  assert.equal(preferences.enabled, true);
  const tableStyles = await page.evaluate(() => {
    const actual = getComputedStyle(document.querySelector('#ai-capabilities tbody td'));
    const reference = getComputedStyle(document.querySelector('#sync-logs-tbody td'));
    return {actual: [actual.color, actual.backgroundColor], reference: [reference.color, reference.backgroundColor]};
  });
  assert.deepEqual(tableStyles.actual, tableStyles.reference, 'model results must use the existing readable table theme without selecting text');
  await page.setViewportSize({width: 390, height: 844});
  const tableLayout = await page.locator('#ai-capabilities table').evaluate(table => {
    const container = table.parentElement;
    container.scrollLeft = container.scrollWidth;
    return {scrollable: getComputedStyle(container).overflowX, right: table.getBoundingClientRect().right, containerRight: container.getBoundingClientRect().right, viewport: innerWidth};
  });
  assert.equal(tableLayout.scrollable, 'auto', 'wide model tables need the shared responsive scroll container');
  assert(tableLayout.right <= tableLayout.containerRight + 1 && tableLayout.containerRight <= tableLayout.viewport, 'last model-result column stays reachable on mobile');
  await page.setViewportSize({width: 1280, height: 720});
  discoveredModels = [{id: 'image-first', candidate: 'other'}, {id: 'chat-two', candidate: 'text'}];
  await page.locator('#ai-discover').click();
  await page.locator('#ai-models option[value="chat-two"]').waitFor();
  assert.equal(await page.locator('#ai-model').inputValue(), 'chat-one', 'refresh and removal preserve the saved selection');
  assert.deepEqual(await page.locator('#ai-models').evaluate(select => [...select.selectedOptions].map(option => option.value)), ['chat-one'], 'removed selection is retained explicitly, never replaced by list order');
  await page.locator('#ai-models').selectOption(['chat-two']);
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-capabilities').textContent.includes('chat-two'));
  assert.equal(await page.locator('#ai-model').inputValue(), 'chat-one', 'testing a candidate does not silently replace a selected model');
  assert.equal(await page.locator('#ai-token-parameter').inputValue(), 'max_tokens', 'testing does not change an in-use parameter profile');
  await page.locator('#ai-recommendation').click();
  assert.equal(await page.locator('#ai-model').inputValue(), 'chat-two');
  assert.equal(await page.locator('#ai-token-parameter').inputValue(), 'max_completion_tokens', 'explicit adoption includes the successfully tested profile');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(item => item.includes('synthetic-secret'))), false);
  discoverFails = true;
  await page.locator('#ai-discover').click();
  await page.waitForFunction(() => document.getElementById('ai-setup-status').dataset.i18n === 'ai_network');
  for (const [status, code, message] of [[409, 'AI_BUSY', 'busy'], [429, 'AI_PAUSED', 'paused'], [504, 'AI_TIMEOUT', 'timeout']]) {
    discoverError = {status, code};
    await page.locator('#ai-discover').click();
    await page.waitForFunction(key => document.getElementById('ai-setup-status').dataset.i18n === `ai_${key}`, message);
    assert.notEqual(await page.locator('#ai-setup-status').innerText(), `ai_${message}`, 'connection-state explanations must be translated');
  }
  await page.locator('summary[data-i18n="ai_advanced"]').click();
  await page.locator('#ai-model').fill('');
  await page.locator('#ai-models').selectOption([]);
  const testsBeforeEmptySelection = requests.filter(request => request.path.endsWith('/test')).length;
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-setup-status').dataset.i18n === 'ai_modelTestSelection');
  assert.equal(requests.filter(request => request.path.endsWith('/test')).length, testsBeforeEmptySelection, 'empty model selection must not start a provider test');
  await page.locator('#ai-model').fill('manual-alias');
  await page.locator('#ai-models').selectOption([]);
  await page.locator('#ai-test').click();
  await page.waitForFunction(() => document.getElementById('ai-capabilities').textContent.includes('manual-alias'));
  assert.equal(requests.filter(r => r.path.endsWith('/test')).at(-1).body.model_ids[0], 'manual-alias');
  await page.locator('#ai-prompt').fill('Review my list');
  const jobsBeforeMissingUser = requests.filter(request => request.path === '/jobs' && request.method === 'POST').length;
  await page.locator('#ai-run').click();
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_targetUserRequired', 'missing administrator target must not be reported as a model-test problem');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ai-user', 'focus the missing target field');
  assert.equal(requests.filter(request => request.path === '/jobs' && request.method === 'POST').length, jobsBeforeMissingUser, 'missing target cannot submit inference');
  await page.locator('#ai-feature').selectOption('cleanup');
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_inputChanged', 'changing features must clear stale validation feedback');
  await page.locator('#ai-feature').selectOption('list');
  await page.locator('#ai-run').click();
  await page.locator('#ai-user').selectOption('2');
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_inputChanged', 'editing a rejected field must replace stale validation feedback without claiming it was saved');

  let policyStarted;
  const pendingPolicy = new Promise(resolve => { policyStarted = resolve; });
  policyGate = {started: policyStarted};
  await page.locator('#ai-save-policy').click();
  await pendingPolicy;
  await page.locator('#nav-dashboard').click();
  await page.locator('#nav-ai').click();
  assert.equal(await page.locator('#ai-run').isDisabled(), true, 'a pending reset cannot race a new job');
  await page.locator('#ai-cancel').click();
  assert.equal(await page.locator('#ai-save-policy').isDisabled(), true, 'unrelated action cleanup must not unlock a pending reset');
  assert.equal(await page.locator('#ai-run').isDisabled(), true);
  const postsBeforePolicy = requests.filter(request => request.path === '/jobs' && request.method === 'POST').length;
  await page.locator('#ai-run').evaluate(button => button.click());
  assert.equal(requests.filter(request => request.path === '/jobs' && request.method === 'POST').length, postsBeforePolicy);
  policyGate.release(); policyGate = null;
  await page.waitForFunction(() => document.getElementById('ai-policy-status')?.dataset.i18n === 'ai_saved' && !document.getElementById('ai-save-policy').disabled);
  assert.equal(await page.locator('#ai-run').isDisabled(), false);
  await page.locator('#ai-user').selectOption('2');
  await page.locator('#ai-prompt').fill('Review my list');

  page.on('dialog', dialog => dialog.accept());
  await page.locator('#ai-run').click();
  await waitForJobCreation;
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_queued', 'submission must show progress before the server responds');
  assert.equal(await page.locator('#ai-work-progress .spinner-border').isVisible(), true);
  assert.equal(await page.locator('#ai-run').isDisabled(), true);
  for (const id of ['connection', 'feature', 'user', 'channel-ids', 'new-search', 'save-policy', 'save-preference', 'delete-connection', 'clear-history']) {
    assert.equal(await page.locator(`#ai-${id}`).isDisabled(), true, `${id} cannot abandon an in-flight job submission`);
  }
  await page.locator('#nav-ai').click();
  await page.locator('#nav-dashboard').click();
  await page.locator('#nav-ai').click();
  assert.equal(await page.locator('#ai-run').isDisabled(), true, 'navigation retains the pending submission');
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_queued');
  const localFeedback = await page.locator('#ai-work-progress').boundingBox();
  const runButton = await page.locator('#ai-run').boundingBox();
  assert(localFeedback.y >= runButton.y && localFeedback.y - runButton.y < 160, 'progress is beside the job controls, not only at the top of the page');
  delayJobCreation = false; releaseJobCreation();
  await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_running');
  await page.locator('#ai-action-a1').waitFor();
  assert.equal(await page.locator('#ai-work-status').getAttribute('data-i18n'), 'ai_completed');
  assert.equal(await page.locator('#ai-work-progress .spinner-border').isVisible(), false);
  assert.equal(await page.locator('#ai-result img').count(), 0);
  assert.equal(await page.locator('#ai-proposal script').count(), 0);
  assert.equal(await page.evaluate(() => window.hostile), undefined);
  assert.match(await page.locator('#ai-result').innerText(), /Analyzed items: 2000 \/ 2000/);
  assert.match(await page.locator('#ai-result').innerText(), /Displayed item examples: 20 \/ 2000/);
  assert.equal(await page.locator('#ai-action-a1').isChecked(), false, 'changes never preselected');
  const beforeSelection = requests.length;
  await page.locator('#ai-select-all').click();
  assert.equal(await page.locator('#ai-proposal [data-ai-action]:checked').count(), 3);
  await page.locator('#ai-deselect-all').click();
  assert.equal(await page.locator('#ai-proposal [data-ai-action]:checked').count(), 0);
  assert.equal(requests.length, beforeSelection, 'bulk selection is local and never applies changes');
  await page.locator('#ai-action-a1').check();
  await page.locator('#ai-apply').click();
  await page.locator('#ai-undo').waitFor();
  assert.equal(await page.locator('#ai-select-all').count(), 0, 'applied actions cannot be selected again');
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
  await page.waitForFunction(() => document.getElementById('ai-rules-status')?.dataset.i18n === 'ai_saved');
  assert.equal(await page.locator('#ai-rules-progress').isVisible(), true, 'rule feedback appears inside the open rules section');
  assert.equal(requests.find(r => r.path === '/rules/r1' && r.method === 'PUT').body.enabled, true);
  assert.deepEqual(requests.find(r => r.path === '/rules' && r.method === 'POST').body.exceptions, ['Regional', 'HD']);
  await page.locator('#ai-undo').click();
  await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_undone');
  await page.locator('#ai-run').click();
  await page.locator('#ai-action-a1').waitFor();
  await page.locator('#ai-select-all').click();
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
    assert.deepEqual(await page.locator('#view-ai [data-i18n]').evaluateAll(items => items
      .filter(item => !translations[currentLang][item.dataset.i18n] || item.textContent !== t(item.dataset.i18n))
      .map(item => item.dataset.i18n)), [], `AI labels use the selected ${lang} translations`);
    assert.match(await page.locator('#view-ai [data-i18n="ai_intro"]').innerText(), /experimental|experimentell|expérimental|πειραματικ/i);
  }
  await page.locator('summary[data-i18n="ai_scope"]').click();
  await page.locator('#ai-channel-ids').fill('5,6');
  await page.locator('#ai-pinned').fill('6');
  await page.locator('#ai-keep-first').fill('1');
  for (const feature of ['cleanup', 'duplicates', 'epg', 'sync', 'diagnose', 'text']) {
    await page.locator('#ai-feature').selectOption(feature);
    if (feature === 'text') nextJobResult = {feature:'text',summary:'',text:'Translated description',tags:['Sport']};
    await page.locator('#ai-run').click();
    if (feature === 'text') {
      await page.getByText('Translated description', {exact:true}).waitFor();
      assert.doesNotMatch(await page.locator('#ai-result').innerText(), /No results/);
      nextJobResult = null;
    } else await page.locator('#ai-action-a1').waitFor();
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
  await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_cancelled');
  for (const terminalStatus of ['completed', 'failed']) {
    cancelNext = true;
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_running');
    cancelNext = false; cancelResult = terminalStatus;
    nextJobError = terminalStatus === 'failed' ? 'AI_TIMEOUT' : null;
    const posts = requests.filter(r => r.path === '/jobs' && r.method === 'POST').length;
    await page.locator('#ai-cancel').click();
    await page.waitForFunction(key => document.getElementById('ai-work-status').dataset.i18n === key, terminalStatus === 'completed' ? 'ai_completed' : 'ai_timeout');
    if (terminalStatus === 'completed') await page.locator('#ai-action-a1').waitFor();
    assert.equal(requests.filter(r => r.path === '/jobs' && r.method === 'POST').length, posts, 'late cancellation retrieves the existing terminal result without creating a job');
  }
  cancelNext = true; cancelResult = 'cancelled'; nextJobError = null;
  for (const cancelStatus of [200, 502]) {
    await page.locator('#ai-feature').selectOption('list');
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_running');
    let cancelStarted;
    const started = new Promise(resolve => { cancelStarted = resolve; });
    cancelGate = {path: `/jobs/j${jobCount}/cancel`, status: cancelStatus, started: cancelStarted};
    await page.locator('#ai-cancel').click();
    await started;
    const historySection = page.locator('details').filter({has: page.locator('#ai-clear-history')}).locator('summary');
    await historySection.click();
    await page.locator('#ai-refresh-history').click();
    await page.locator('#ai-history-historyA').waitFor();
    assert.equal(await page.locator('#ai-history-historyA').isDisabled(), true, 'history cannot replace a running job');
    assert.equal(await page.locator('#ai-change-ruleChange').isDisabled(), true, 'stored changes cannot replace a running job');
    await historySection.click();
    await page.locator('#nav-dashboard').click();
    await page.locator('#nav-ai').click();
    assert.equal(await page.locator('#ai-cancel').isDisabled(), true, 'navigation retains the pending cancellation');
    const activeJobPath = `/jobs/j${jobCount}`;
    const posts = requests.filter(request => request.path === '/jobs' && request.method === 'POST').length;
    for (const id of ['connection', 'feature', 'user', 'channel-ids', 'new-search', 'save-policy', 'save-preference', 'delete-connection', 'clear-history']) {
      assert.equal(await page.locator(`#ai-${id}`).isDisabled(), true, `${id} waits for cancellation acknowledgement`);
    }
    await page.locator('#ai-run').click();
    assert.equal(requests.filter(request => request.path === '/jobs' && request.method === 'POST').length, posts, 'pending cancellation must not permit another job');
    await Promise.all([page.waitForResponse(response => response.url().endsWith(cancelGate.path)), Promise.resolve().then(() => cancelGate.release())]);
    await page.waitForFunction(() => !document.getElementById('ai-cancel').disabled);
    cancelGate = null;
    if (cancelStatus === 502) {
      assert.equal(await page.locator('#ai-connection').isDisabled(), true, 'failed cancellation retains the active job');
      await page.waitForResponse(response => response.url().endsWith(activeJobPath) && response.request().method() === 'GET');
      await page.locator('#ai-cancel').click();
    }
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_cancelled');
    for (const id of ['connection', 'feature', 'user', 'channel-ids', 'new-search', 'save-policy', 'save-preference', 'delete-connection', 'clear-history']) {
      assert.equal(await page.locator(`#ai-${id}`).isDisabled(), false, `${id} becomes available after cancellation`);
    }
    await page.locator('#ai-connection').selectOption('');
    await page.locator('#ai-connection').selectOption('c1');
    await page.locator('#ai-feature').selectOption('duplicates');
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_running');
    assert.equal(jobCount, Number(activeJobPath.slice('/jobs/j'.length)) + 1, 'a new context can submit after cancellation');
    await page.locator('#ai-cancel').click();
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_cancelled');
  }
  cancelNext = false; pollErrorOnce = true;
  await page.locator('#ai-run').click();
  await page.locator('#ai-refresh-job').waitFor({state: 'visible'});
  const retryJob = `/jobs/j${jobCount}`;
  const postsBeforeRetry = requests.filter(r => r.path === '/jobs' && r.method === 'POST').length;
  await page.locator('#ai-refresh-job').click();
  await page.locator('#ai-action-a1').waitFor();
  assert.equal(await page.locator('#ai-refresh-job').isVisible(), false);
  assert.equal(requests.filter(r => r.path === '/jobs' && r.method === 'POST').length, postsBeforeRetry, 'retrying status never resubmits an inference job');
  assert(requests.filter(r => r.path === retryJob && r.method === 'GET').length >= 3, 'polling resumes for the same job through completion');
  await page.locator('details').filter({has: page.locator('#ai-clear-history')}).locator('summary').click();
  await page.locator('#ai-clear-history').click();
  await page.waitForFunction(() => document.getElementById('ai-history-status').dataset.i18n === 'ai_saved');
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
  for (const certainty of ['proven', 'possible', 'unknown']) assert.equal(await page.locator(`#ai-result h4[data-i18n="ai_${certainty}"]`).count(), 1, 'diagnosis separates facts, hypotheses and unknowns');
  assert.match(await page.locator('#ai-result').innerText(), /not implemented measurements/);
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
  await page.locator('#ai-user').selectOption('3');
  assert.equal(await page.locator('#ai-program option').count(), 1, 'target-user change clears EPG references');
  assert.equal(await page.locator('#ai-program-description').innerText(), '');
  nextJobError = 'AI_INVALID_DEPENDENCY';
  await page.locator('#ai-feature').selectOption('list');
  await page.locator('#ai-run').click();
  await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_invalidOutput');
  assert.equal(await page.locator('#ai-work-progress .spinner-border').isVisible(), false);
  assert.equal(await page.locator('#ai-proposal').innerText(), '', 'invalid model dependencies expose no actionable proposal');
  if (process.env.AI_UI_SCREENSHOT) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({path: process.env.AI_UI_SCREENSHOT});
  }
  connections[0] = {...connections[0], shared: true, editable: false, model_id: 'current-admin-model'};
  preferences.connection_id = 'c1';
  preferences.model_id = 'previous-admin-model';
  const userListRequests = requests.filter(request => request.path === '/api/users').length;
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 2, is_admin: false}; await aiUI.open(); });
  assert.equal(requests.filter(request => request.path === '/api/users').length, userListRequests, 'normal users never load administrator user choices');
  assert.equal(await page.locator('#ai-user').count(), 0, 'normal users cannot select another library');
  assert.equal(await page.locator('#ai-key').count(), 0, 'borrowed setup never asks for keys');
  assert.equal(await page.locator('#ai-model').getAttribute('readonly'), '');
  assert.equal(await page.locator('#ai-model').inputValue(), 'current-admin-model', 'shared setup uses the current administrative selection, not stale personal preferences');
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/ai/preferences') && response.request().postDataJSON()?.model_id === 'current-admin-model'), page.locator('#ai-finish').click()]);
  assert.equal(await page.locator('#ai-model-controls').isVisible(), false, 'borrowed connection cannot be tested or changed');
  cancelNext = true; nextJobError = null;
  for (const change of ['actor', 'token']) {
    await page.locator('#ai-prompt').fill('Private running request');
    await page.locator('#ai-run').click();
    await page.waitForFunction(() => document.getElementById('ai-work-status').dataset.i18n === 'ai_running');
    await page.evaluate(async change => {
      if (change === 'actor') currentUser = {id: 3, is_admin: false};
      else localStorage.setItem('jwt_token', 'synthetic-replacement-token');
      await aiUI.open();
    }, change);
    assert.equal(await page.locator('#ai-prompt').inputValue(), '', `reopening after a ${change} change must not retain the old job view`);
    assert.equal(await page.locator('#ai-connection').isDisabled(), false);
  }
  cancelNext = false;
  await page.evaluate(() => { localStorage.removeItem('jwt_token'); aiUI.clear(); });
  assert.equal(await page.locator('#view-ai').innerText(), '', 'logout cleanup removes all AI state');
  await page.evaluate(() => {
    const original = fetchJSON; window.originalAiFetch = original;
    fetchJSON = url => url === '/api/ai/settings' ? new Promise(resolve => { window.releaseAiSettings = () => resolve({enabled: true}); }) : original(url);
    window.pendingAiOpen = aiUI.open();
  });
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 3, is_admin: false}; window.releaseAiSettings(); await window.pendingAiOpen; });
  assert.equal(await page.locator('#view-ai').innerText(), '', 'late prior-user response cannot repopulate UI');
  await page.evaluate(() => {
    aiUI.clear(); currentUser = {id: 1, is_admin: true};
    const original = window.originalAiFetch; window.finishedAiReads = 0;
    fetchJSON = url => url === '/api/users' ? new Promise(resolve => { window.releaseUserChoices = () => resolve([{id: 8, username: 'Late admin-only name'}]); }) : original(url).then(result => { window.finishedAiReads++; return result; });
    window.pendingUserChoices = aiUI.open();
  });
  await page.waitForFunction(() => typeof window.releaseUserChoices === 'function' && window.finishedAiReads === 4);
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 2, is_admin: false}; window.releaseUserChoices(); await window.pendingUserChoices; });
  assert.equal(await page.locator('#view-ai').innerText(), '', 'late administrator user list cannot repopulate a cleared or different session');
  // Personal ChatGPT account link. Offered only when the server reports a
  // contained runtime, private by construction, and never showing a token.
  // The session-isolation checks above leave `fetchJSON` patched to stall the
  // administrator user list, so restore the real reader first.
  await page.evaluate(() => { aiUI.clear(); if (window.originalAiFetch) fetchJSON = window.originalAiFetch; });
  settings = {enabled: true, allow_own_connections: true, allowed_user_ids: [2, 99], functions: features, internal_targets: []};
  preferences = {enabled: true, connection_id: null, model_id: null};
  connections = [];
  await page.evaluate(async () => { currentUser = {id: 1, is_admin: true}; await aiUI.open(); });
  await page.locator('#ai-connection').waitFor();
  assert.deepEqual(await page.locator('#ai-connection option').evaluateAll(items => items.map(item => item.value)), ['', 'new'],
    'the ChatGPT option is hidden while the server reports no contained runtime');

  codexAvailable = true;
  await page.evaluate(async () => { aiUI.clear(); currentUser = {id: 1, is_admin: true}; await aiUI.open(); });
  await page.locator('#ai-connection').waitFor();
  assert.deepEqual(await page.locator('#ai-connection option').evaluateAll(items => items.map(item => item.value)), ['', 'new', 'new-chatgpt'],
    'the ChatGPT option appears once the server reports a contained runtime');
  await page.locator('#ai-connection').selectOption('new-chatgpt');
  for (const field of ['url', 'key', 'shared', 'connection-users']) {
    assert.equal(await page.locator(`#ai-${field}`).count(), 0, `a managed ChatGPT sign-in must not ask for ${field}`);
  }
  assert.equal(await page.locator('#ai-advanced').isVisible(), false, 'no token-limit parameter is offered for a managed sign-in');
  assert.equal(await page.locator('#ai-token-parameter').isDisabled(), true);
  assert.match(await page.locator('#ai-destination').innerText(), /Codex/, 'the managed destination is named before any request');
  assert.match(await page.locator('#ai-account-panel').innerText(), /no OpenAI platform API key|kein OpenAI-Platform-API-Key/i,
    'the disclosure states that no platform API key is needed');
  assert.equal(await page.locator('#ai-unlink').isVisible(), false, 'nothing can be disconnected before a sign-in');

  assert.equal(await page.locator('#ai-name').inputValue(), '', 'a new account link starts without a custom name');
  await page.locator('#ai-enabled').check();
  let resetBeforeLink;
  const pendingLinkReset = new Promise(resolve => { resetBeforeLink = resolve; });
  policyGate = {started: resetBeforeLink};
  await page.locator('details').filter({has: page.locator('#ai-policy-enabled')}).locator('summary').click();
  await page.locator('#ai-save-policy').click();
  await pendingLinkReset;
  await page.locator('#ai-cancel').click();
  assert.equal(await page.locator('#ai-link-start').isDisabled(), true, 'a delayed reset cannot race link creation');
  policyGate.release(); policyGate = null;
  await page.waitForFunction(() => document.getElementById('ai-policy-status')?.dataset.i18n === 'ai_saved');
  await page.locator('#ai-connection').selectOption('new-chatgpt');
  await page.locator('#ai-enabled').check();
  let linkStarted;
  const pendingLink = new Promise(resolve => { linkStarted = resolve; });
  linkGate = {started: linkStarted};
  await page.locator('#ai-link-start').click();
  await pendingLink;
  for (const id of ['connection', 'save-policy', 'save-preference', 'delete-connection', 'clear-history', 'run']) {
    assert.equal(await page.locator(`#ai-${id}`).isDisabled(), true, `${id} cannot abandon link creation`);
  }
  await page.locator('#nav-dashboard').click();
  await page.locator('#nav-ai').click();
  assert.equal(await page.locator('#ai-link-start').isDisabled(), true, 'navigation retains pending link creation');
  linkGate.release(); linkGate = null;
  await page.locator('#ai-link-state a').waitFor();
  await page.locator('#nav-ai').click();
  await page.locator('#nav-dashboard').click();
  await page.locator('#nav-ai').click();
  assert.match(await page.locator('#ai-link-state').innerText(), /ABCD-1234/, 'navigation retains the same device code');
  await page.waitForResponse(response => response.url().endsWith('/connections/c2/link/L1') && response.request().method() === 'GET');
  assert.equal(connections.find(item => item.id === 'c2').name, 'ChatGPT',
    'connecting without a custom name uses ChatGPT rather than silently blocking sign-in');
  assert.equal(await page.locator('#ai-link-state a').getAttribute('href'), 'https://auth.openai.com/codex/device',
    'only the approved verification address becomes a link');
  assert.equal(await page.locator('#ai-link-state a').getAttribute('rel'), 'noopener noreferrer');
  assert.match(await page.locator('#ai-link-state').innerText(), /ABCD-1234/, 'the device code is shown');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#ai-link-code').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'ABCD-1234',
    'clicking the device code copies only the code, not its caption or verification URL');
  await page.waitForFunction(() => document.getElementById('ai-link-code').getAttribute('aria-label') === t('copied'));
  assert.equal(await page.locator('#ai-link-cancel').isVisible(), true, 'a pending sign-in can be cancelled');
  assert.equal(await page.locator('#ai-account-progress').isVisible(), true, 'account feedback stays beside the account controls');
  assert.equal(await page.locator('#ai-status').isVisible(), false, 'account sign-in does not require scrolling to the page header');
  failLinkCancel = true;
  await page.locator('#ai-link-cancel').click();
  await page.waitForFunction(() => document.getElementById('ai-account-status').dataset.i18n === 'ai_network');
  assert.equal(await page.locator('#ai-connection').isDisabled(), true, 'failed cancellation retains the pending sign-in');
  await page.waitForResponse(response => response.url().endsWith('/connections/c2/link/L1') && response.request().method() === 'GET');
  assert.match(await page.locator('#ai-link-state').innerText(), /ABCD-1234/, 'failed cancellation resumes watching the same code');

  failNextPolls = 15;
  for (let failure = 0; failure < 15; failure++) {
    await page.waitForResponse(response => response.url().endsWith('/connections/c2/link/L1') && response.status() === 502);
  }
  await page.waitForFunction(() => document.getElementById('ai-account-status').dataset.i18n === 'ai_network');
  assert.match(await page.locator('#ai-link-state').innerText(), /ABCD-1234/, 'transport retry exhaustion retains the pending identity');
  assert.equal(await page.locator('#ai-link-cancel').isVisible(), true, 'a transport outage does not remove cancellation');
  assert.equal(await page.locator('#ai-connection').isDisabled(), true);
  const linksBeforeRecovery = requests.filter(request => request.path === '/connections/c2/link' && request.method === 'POST').length;
  await page.locator('#ai-link-refresh').click();
  await page.waitForResponse(response => response.url().endsWith('/connections/c2/link/L1') && response.request().method() === 'GET');
  assert.equal(requests.filter(request => request.path === '/connections/c2/link' && request.method === 'POST').length, linksBeforeRecovery, 'status retry resumes the same attempt without creating a new link');
  assert.match(await page.locator('#ai-link-state').innerText(), /ABCD-1234/);
  await page.locator('#ai-link-cancel').click();
  await page.waitForFunction(() => document.getElementById('ai-account-status').dataset.i18n === 'ai_linkCancelled');
  await page.locator('#ai-link-start').click();
  await page.locator('#ai-link-code').waitFor();
  missingLink = true;
  await page.waitForFunction(() => document.getElementById('ai-connection').disabled === false);
  assert.equal(await page.locator('#ai-link-start').isDisabled(), false, 'a definitively missing attempt permits a fresh sign-in');
  assert.equal(await page.locator('#ai-link-code').count(), 0, 'an expired attempt no longer exposes an active device code');
  await page.locator('#ai-link-start').click();
  await page.locator('#ai-link-code').waitFor();
  const linkRequests = requests.filter(request => request.path.includes('/link'));
  assert.equal(JSON.stringify(linkRequests).includes('token'), false, 'no token is ever sent or echoed by the browser');

  // A transient status failure must not abandon a sign-in that is still open:
  // the server drops an attempt that stops being polled.
  failNextPolls = 2;
  await page.waitForFunction(() => document.getElementById('ai-account-status')?.dataset.i18n === 'ai_linkRetrying', null, {timeout: 20000});
  assert.equal(await page.locator('#ai-link-state a').count(), 1, 'the device code stays on screen while retrying');

  // The account holder completes the sign-in; the poll adopts only its own attempt.
  chatgptAccount = {linked: true, label: 'p***@example.org', plan_type: 'plus', auth_method: 'chatgpt'};
  loginState = {id: 'L1', status: 'completed', verification_url: null, user_code: null, error_code: null, expires_at: Date.now() + 900000};
  Object.assign(connections.find(item => item.id === 'c2'), {account: chatgptAccount});
  await page.locator('#ai-unlink').waitFor({state: 'visible', timeout: 20000});
  assert.match(await page.locator('#ai-account-state').innerText(), /p\*\*\*@example\.org/, 'only the masked account label is shown');
  assert.match(await page.locator('#ai-account-state').innerText(), /42%/, 'reported quota is displayed');
  assert.equal(await page.locator('#ai-link-start').isVisible(), false, 'a linked account offers no second sign-in');

  for (const [lang, linkedText, planCaption] of [
    ['de', 'ChatGPT-Konto verbunden', 'Tarif'], ['fr', 'Compte ChatGPT connecté', 'Forfait'],
    ['el', 'Ο λογαριασμός ChatGPT συνδέθηκε', 'Πρόγραμμα'], ['en', 'ChatGPT account connected', 'Plan']]) {
    await page.locator('#language-selector').selectOption(lang);
    const panel = await page.locator('#ai-account-panel').innerText();
    assert.ok(panel.includes(linkedText), `the linked state is translated for ${lang}`);
    assert.ok(panel.includes(`${planCaption}: plus`), `account captions re-translate on a language change for ${lang}`);
    assert.equal(await page.locator('#ai-url').count(), 0, `no technical address field appears for ${lang}`);
  }
  await page.locator('#language-selector').selectOption('en');

  // A refreshed account read that no longer authenticates must win over the
  // stored connection record, or the panel keeps claiming the account is linked.
  accountReadsLinked = false;
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/connections/c2/account')),
    page.locator('#ai-account-refresh').click()
  ]);
  await page.locator('#ai-link-start').waitFor({state: 'visible'});
  assert.match(await page.locator('#ai-account-state').innerText(), /No ChatGPT account connected/i,
    'a refreshed account read that reports no link is shown instead of the stored record');
  assert.equal(await page.locator('#ai-unlink').isVisible(), false, 'a refreshed unlinked account offers no disconnect');
  // Re-selecting the connection reloads the panel from the stored record, which
  // still holds the link, so the disconnect path below can run.
  accountReadsLinked = true;
  await page.evaluate(() => document.getElementById('ai-connection').dispatchEvent(new Event('change')));
  await page.locator('#ai-unlink').waitFor({state: 'visible'});

  // A page-wide dialog handler is already installed above; the disconnect
  // confirmation is accepted by it.
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/connections/c2/unlink')),
    page.locator('#ai-unlink').click()
  ]);
  await page.locator('#ai-link-start').waitFor({state: 'visible'});
  assert.equal(await page.locator('#ai-unlink').isVisible(), false, 'disconnecting returns the panel to the unlinked state');

  // An address outside the documented targets is reported, never opened.
  verificationUrl = 'https://phish.example/codex/device';
  await Promise.all([
    page.waitForResponse(response => response.url().includes('/connections/c2/link') && response.request().method() === 'POST'),
    page.locator('#ai-link-start').click()
  ]);
  await page.locator('#ai-link-state').waitFor();
  assert.equal(await page.locator('#ai-link-state a').count(), 0, 'an unapproved verification address is never turned into a link');
  assert.match(await page.locator('#ai-link-state').innerText(), /not an approved target/i);
  await page.locator('#ai-link-cancel').click();
  await page.waitForFunction(() => document.getElementById('ai-account-status').dataset.i18n === 'ai_linkCancelled');
  assert.equal(await page.locator('#ai-connection').isDisabled(), false, 'acknowledged cancellation unlocks the connection');
  await page.evaluate(() => aiUI.clear());

  console.log(`PASS AI UI (${Math.round(performance.now() - startedAt)} ms): setup and all eight functions; confirmed rename rules; follow-up filter patches; delayed history/Undo isolation; read-only cleanup; automatic rule-change history/Undo; local EPG picker and stale-target isolation; analyzed/displayed counts; four languages; personal ChatGPT link, quota, disconnect and blocked verification target; session isolation. Synthetic API only.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
