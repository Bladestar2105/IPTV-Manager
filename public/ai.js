/* Optional AI management. All service/model values are rendered as plain text. */
window.aiUI = (() => {
  const features = ['list', 'cleanup', 'duplicates', 'epg', 'sync', 'search', 'diagnose', 'text'];
  let generation = 0, owner = '', sessionToken = null, timer, connections = [], userChoices = [], settings = {}, preferences = {};
  let jobId, proposal, changeId, conversationId, recommendation, nextOffset = 0, resultGeneration = 0;
  let appliedActionIds = [];
  let filterBaseline = {};
  let programs = [], programScope = '', programGeneration = 0;
  let codex = {available: false, reason: null}, login = null, loginTimer, accountState = null;
  // Mirrors the server-side allowlist so an unexpected address is never linked.
  const LOGIN_HOSTS = ['auth.openai.com', 'chatgpt.com', 'auth.chatgpt.com'];
  // Roughly a minute of retries, well inside the server's two-minute window for
  // an attempt that is still being watched.
  const MAX_LINK_POLL_FAILURES = 15;
  const root = () => document.getElementById('view-ai');
  const el = id => document.getElementById(`ai-${id}`);
  const value = id => el(id)?.value?.trim() || '';
  const checked = id => Boolean(el(id)?.checked);
  const actor = () => currentUser ? `${currentUser.is_admin ? 'admin' : 'user'}:${currentUser.id}` : '';
  const tr = key => t(`ai_${key}`);
  const list = (data, key) => Array.isArray(data) ? data : data?.[key] || [];
  const printable = data => typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  function node(tag, parent, text, className = '') {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = String(text);
    if (className) item.className = className;
    if (parent) parent.append(item);
    return item;
  }
  function label(tag, parent, key, className) {
    const item = node(tag, parent, tr(key), className);
    item.dataset.i18n = `ai_${key}`;
    return item;
  }
  function field(parent, id, key, type = 'text', initial = '') {
    const wrap = node('div', parent, undefined, 'mb-3');
    const caption = label('label', wrap, key, 'form-label');
    caption.htmlFor = `ai-${id}`;
    const item = node(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', wrap);
    item.id = `ai-${id}`;
    if (!['textarea', 'select'].includes(type)) item.type = type;
    item.className = type === 'checkbox' ? 'form-check-input ms-2' : type === 'select' ? 'form-select' : 'form-control';
    if (type === 'checkbox') item.checked = Boolean(initial);
    else item.value = initial ?? '';
    if (type === 'textarea') { item.rows = 3; item.maxLength = 8000; }
    if (type === 'number') { item.min = '0'; item.step = '1'; }
    for (const event of ['input', 'change']) item.addEventListener(event, () => {
      if (['ai_invalid', 'ai_targetUserRequired', 'ai_modelTestSelection'].includes(el('status')?.dataset.i18n)) status('inputChanged', item.closest('[data-ai-section]')?.dataset.aiSection);
    });
    return item;
  }
  function option(select, val, text, key) {
    const item = node('option', select, key ? tr(key) : text);
    item.value = val;
    if (key) item.dataset.i18n = `ai_${key}`;
    return item;
  }
  function userSelect(parent, id, key, selected = [], multiple = false) {
    const select = field(parent, id, key, 'select');
    select.multiple = multiple;
    if (multiple) {
      select.size = 4;
      const hint = label('p', select.parentElement, 'userSelectionHint', 'form-text');
      hint.id = `${select.id}-help`; select.setAttribute('aria-describedby', hint.id);
    } else option(select, '', '', 'choose');
    for (const user of userChoices) option(select, user.id, user.username).selected = selected.includes(user.id);
    if (multiple) {
      for (const missing of selected.filter(id => !userChoices.some(user => user.id === id))) option(select, missing, '', 'unavailableUser').selected = true;
    } else if (!selected.some(id => userChoices.some(user => user.id === id))) select.value = '';
    return select;
  }
  function button(parent, id, key, callback, style = 'outline-primary') {
    const item = label('button', parent, key, `btn btn-${style} me-2 mb-2`);
    item.id = `ai-${id}`;
    item.type = 'button';
    item.addEventListener('click', () => run(callback, item));
    return item;
  }
  function section(key, expanded = false) {
    const container = node('details', root(), undefined, 'card mb-3');
    container.open = expanded; container.dataset.aiSection = key;
    label('summary', container, key, 'card-header');
    return node('div', container, undefined, 'card-body');
  }
  function progress(parent, scope) {
    const box = node('div', parent, undefined, 'alert alert-info'); box.id = `ai-${scope}-progress`;
    const spinner = node('span', box, undefined, 'spinner-border spinner-border-sm me-2');
    spinner.setAttribute('aria-hidden', 'true'); spinner.hidden = true;
    node('span', box).id = `ai-${scope}-status`;
  }
  function status(key, scope = 'work') {
    for (const id of ['status', `${scope}-status`]) {
      const item = el(id); if (!item) continue;
      item.dataset.i18n = `ai_${key}`; item.textContent = tr(key);
    }
    const box = el(`${scope}-progress`);
    if (box) {
      const busy = ['queued', 'running'].includes(key);
      box.setAttribute('aria-busy', String(busy)); box.querySelector('.spinner-border').hidden = !busy;
    }
  }
  function errorKey(error) {
    const code = String(error.response?.code || error.code || '').toUpperCase();
    if (code === 'AI_DISABLED') return 'off';
    if (code === 'AI_CODEX_NOT_LINKED') return 'notLinked';
    if (code === 'AI_CODEX_TOOL_REQUEST') return 'toolRequest';
    if (code === 'AI_CODEX_UNEXPECTED_AUTH') return 'unexpectedAuth';
    if (code === 'AI_CODEX_ACCOUNT_ALREADY_LINKED') return 'alreadyLinked';
    if (code === 'AI_CODEX_LOGIN_TARGET_BLOCKED') return 'linkTargetBlocked';
    if (code === 'AI_CODEX_LOGIN_UNSUPPORTED') return 'linkUnsupported';
    if (code === 'AI_CODEX_MANUAL_ONLY') return 'manualOnly';
    if (code.startsWith('AI_CODEX_')) return 'codexUnavailable';
    if (code === 'AI_PERMISSION_DENIED') return 'permission';
    if (code === 'AI_RATE_LIMIT') return 'rateLimit';
    if (code === 'AI_TARGET_USER_REQUIRED') return 'targetUserRequired';
    if (code === 'AI_MODEL_TEST_SELECTION') return 'modelTestSelection';
    if (code === 'AI_BUSY') return 'busy';
    if (code === 'AI_PAUSED') return 'paused';
    if (code === 'AI_TIMEOUT') return 'timeout';
    if (/STALE|CONFLICT|CHANGED/.test(code)) return 'stale';
    if (/FORBIDDEN|DENIED|NOT_ALLOWED|ACCESS|AUTHENTICATION/.test(code)) return 'denied';
    if (/API_KEY|UNAUTHORIZED|AUTH_FAILED/.test(code)) return 'auth';
    if (/RULE/.test(code)) return 'ruleError';
    if (code === 'AI_PROGRAM_REQUIRED') return 'selectProgram';
    if (/MODEL|CAPABILIT/.test(code)) return 'modelError';
    if (/SCHEMA|OUTPUT|RESPONSE_INVALID|INVALID_RESPONSE|INVALID_DEPENDENCY/.test(code)) return 'invalidOutput';
    if (/TIMEOUT|RATE|NETWORK|UPSTREAM|CIRCUIT|DISCOVERY|UNAVAILABLE|BUSY|PAUSED/.test(code)) return 'network';
    if (/INVALID|VALIDATION|REQUIRED|LIMIT/.test(code)) return 'invalid';
    return 'failed';
  }
  async function api(path, method = 'GET', body, resultStamp) {
    const stamp = generation, identity = actor(), token = getToken();
    if (!identity || identity !== owner || token !== sessionToken) throw {code: 'AI_ACCESS_DENIED'};
    let result;
    try {
      result = await fetchJSON(`/api/ai${path}`, {
        method, ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
      });
    } catch (error) {
      if (resultStamp !== undefined && resultStamp !== resultGeneration) return null;
      throw error;
    }
    // A late response from a previous login must never repopulate the page.
    if (stamp !== generation || identity !== actor() || token !== getToken()) throw {code: 'AI_ACCESS_DENIED'};
    return result;
  }
  async function run(callback, control) {
    const stamp = generation;
    if (control) control.disabled = true;
    try { await callback(); }
    catch (error) {
      if (stamp !== generation) return;
      const key = errorKey(error);
      if (key === 'denied') { clear(); label('p', root(), key, 'alert alert-warning'); }
      else status(key, control?.closest('[data-ai-section]')?.dataset.aiSection);
    } finally { if (control?.isConnected) control.disabled = false; }
  }
  function ids(id) {
    const control = el(id);
    const raw = control?.multiple ? [...control.selectedOptions].map(option => option.value).join(',') : value(id);
    if (!raw) return [];
    const values = raw.split(',').map(part => Number(part.trim()));
    if (values.length > 500 || values.some(n => !Number.isSafeInteger(n) || n <= 0)) throw {code: 'AI_INVALID_INPUT'};
    return [...new Set(values)];
  }
  function featureChecks(parent, prefix, selected = features) {
    label('p', parent, 'functions', 'fw-semibold');
    for (const feature of features) field(parent, `${prefix}-${feature}`, feature, 'checkbox', selected.includes(feature));
  }
  const selectedFeatures = prefix => features.filter(feature => checked(`${prefix}-${feature}`));
  const chosen = () => connections.find(connection => connection.id === value('connection'));
  const editable = connection => !connection || (connection.editable ?? (!connection.shared || Boolean(currentUser.is_admin)));

  function beginResult() {
    const stamp = ++resultGeneration;
    proposal = changeId = null; appliedActionIds = [];
    if (el('refresh-job')) el('refresh-job').hidden = true;
    el('result')?.replaceChildren(); el('proposal')?.replaceChildren();
    el('rule-preview-result')?.replaceChildren(); renderRuleActions();
    return stamp;
  }

  function clear() {
    generation++;
    resultGeneration++;
    clearTimeout(timer);
    clearTimeout(loginTimer);
    login = null; accountState = null; codex = {available: false, reason: null};
    owner = ''; sessionToken = null; connections = []; userChoices = []; settings = {}; preferences = {};
    jobId = proposal = changeId = conversationId = recommendation = null;
    appliedActionIds = [];
    filterBaseline = {};
    programs = []; programScope = ''; programGeneration++;
    nextOffset = 0;
    root()?.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
    root()?.replaceChildren();
  }
  async function open() {
    clear();
    owner = actor();
    sessionToken = getToken();
    const stamp = generation, identity = owner, token = sessionToken;
    if (!owner) return;
    label('h2', root(), 'title');
    label('p', root(), 'intro', 'text-muted');
    const state = node('p', root(), undefined, 'alert alert-info');
    state.id = 'ai-status'; state.role = 'status'; state.setAttribute('aria-live', 'polite');
    await run(async () => {
      const loaded = await Promise.all([api('/settings'), api('/preferences'), api('/connections'),
        currentUser.is_admin ? fetchJSON('/api/users').then(users => users.map(({id, username}) => ({id, username})).sort((a, b) => a.username.localeCompare(b.username))) : [],
        // An unavailable optional adapter must not break the rest of the page.
        api('/codex/status').catch(() => ({available: false, reason: 'AI_CODEX_NOT_READY'}))]);
      if (stamp !== generation || identity !== actor() || token !== getToken()) return;
      [settings, preferences, connections, userChoices, codex] = loaded;
      connections = list(connections, 'connections');
      buildPolicy(); buildSetup(); buildWork(); buildRules(); buildHistory();
      status(settings.enabled && preferences.enabled ? 'saved' : 'off', 'setup');
      status(settings.enabled && preferences.enabled ? 'saved' : 'off');
    });
  }
  function buildPolicy() {
    if (!currentUser.is_admin) return;
    const box = section('policy');
    field(box, 'policy-enabled', 'enabled', 'checkbox', settings.enabled);
    field(box, 'own-allowed', 'ownAllowed', 'checkbox', settings.allow_own_connections);
    userSelect(box, 'allowed-users', 'users', settings.allowed_user_ids || [], true);
    field(box, 'targets', 'targets', 'textarea', (settings.internal_targets || []).join('\n'));
    featureChecks(box, 'policy-function', settings.functions || []);
    button(box, 'save-policy', 'save', async () => {
      settings = await api('/settings', 'PUT', {enabled: checked('policy-enabled'), allow_own_connections: checked('own-allowed'), allowed_user_ids: ids('allowed-users'), functions: selectedFeatures('policy-function'), internal_targets: value('targets').split('\n').map(s => s.trim()).filter(Boolean)});
      await open(); status(settings.enabled ? 'saved' : 'off');
    });
  }
  function buildSetup() {
    const box = section('setup', true);
    field(box, 'enabled', 'enabled', 'checkbox', preferences.enabled);
    field(box, 'auto-sync', 'autoSync', 'checkbox', preferences.auto_sync_summary);
    const select = field(box, 'connection', 'connection', 'select');
    option(select, '', '', 'choose');
    for (const connection of connections) option(select, connection.id, connection.name);
    if (currentUser.is_admin || settings.allow_own_connections) {
      option(select, 'new', '', 'own');
      // Offered only where the server actually proved a contained runtime.
      if (codex.available) option(select, 'new-chatgpt', '', 'ownChatgpt');
    }
    select.value = preferences.connection_id || '';
    const details = node('div', box); details.id = 'ai-connection-fields';
    const target = node('p', box, undefined, 'alert alert-secondary');
    label('strong', target, 'destination'); node('span', target, ': ');
    node('span', target).id = 'ai-destination';
    label('p', box, 'disclosure', 'small text-muted');
    const controls = node('div', box); controls.id = 'ai-model-controls';
    button(controls, 'discover', 'discover', async () => {
      await enableSetup();
      const connection = await saveConnection();
      status('running', 'setup');
      const result = await api(`/connections/${encodeURIComponent(connection.id)}/discover`, 'POST', {});
      renderModels(list(result, 'models')); status('saved', 'setup');
    });
    const models = field(controls, 'models', 'models', 'select'); models.multiple = true; models.size = 4;
    label('p', controls, 'candidateHint', 'small text-muted');
    button(controls, 'test', 'test', async () => {
      const selected = [...el('models').selectedOptions].map(opt => opt.value);
      const modelIds = selected.length ? selected : value('model') ? [value('model')] : [];
      if (!modelIds.length || modelIds.length > 3) { el('models').focus(); throw {code: 'AI_MODEL_TEST_SELECTION'}; }
      await enableSetup();
      const connection = await saveConnection();
      status('running', 'setup');
      const result = await api(`/connections/${encodeURIComponent(connection.id)}/test`, 'POST', {model_ids: modelIds});
      connections = list(await api('/connections'), 'connections');
      recommendation = result.recommended_model_id;
      renderCapabilities(result.models);
      el('recommendation').disabled = !recommendation;
      if (!value('model') && result.models.filter(model => model.chat).length === 1 && recommendation) adoptRecommendation();
      status('saved', 'setup');
    });
    progress(controls, 'setup');
    label('p', controls, 'evidence', 'small text-muted');
    label('p', controls, 'profileProbe', 'small text-muted');
    node('div', controls).id = 'ai-capabilities';
    button(controls, 'recommendation', 'recommendation', adoptRecommendation).disabled = true;
    const advanced = node('details', box); advanced.id = 'ai-advanced'; label('summary', advanced, 'advanced');
    const manualModel = field(advanced, 'model', 'model', 'text', preferences.model_id || chosen()?.model_id || '');
    manualModel.addEventListener('input', () => { for (const item of el('models').options) item.selected = false; });
    const parameter = field(advanced, 'token-parameter', 'tokenParameter', 'select');
    for (const val of ['max_tokens', 'max_completion_tokens']) option(parameter, val, val);
    button(box, 'finish', 'finish', async () => {
      const connection = editable(chosen()) ? await saveConnection(true) : chosen();
      if (!connection || !value('model')) throw {code: 'AI_MODEL_REQUIRED'};
      preferences = await api('/preferences', 'PUT', {enabled: checked('enabled'), auto_sync_summary: checked('auto-sync'), connection_id: connection.id, model_id: value('model'), language: value('language'), timezone: value('timezone')});
      status(preferences.enabled ? 'saved' : 'off', 'setup');
    }, 'primary');
    button(box, 'save-preference', 'save', async () => {
      preferences = await api('/preferences', 'PUT', {...preferences, enabled: checked('enabled'), auto_sync_summary: checked('auto-sync')});
      if (!preferences.enabled) { clearTimeout(timer); jobId = null; beginResult(); }
      status(preferences.enabled ? 'saved' : 'off', 'setup');
    });
    button(box, 'delete-connection', 'deleteConnection', async () => {
      if (!chosen() || !confirm(tr('confirmDelete'))) return;
      await api(`/connections/${encodeURIComponent(chosen().id)}`, 'DELETE'); await open();
    }, 'outline-danger');
    select.addEventListener('change', () => {
      clearTimeout(timer); jobId = null;
      beginResult(); conversationId = null;
      filterBaseline = {}; if (el('filters')) el('filters').value = '{}';
      renderConnection();
    });
    renderConnection();
  }
  const pendingProvider = () => {
    const selection = value('connection');
    if (selection === 'new-chatgpt') return 'chatgpt_account';
    if (selection === 'new') return 'openai_api';
    return chosen()?.provider || 'openai_api';
  };
  // Mirrors the documented verification targets. An address outside them is
  // never turned into a link the account holder could follow.
  function safeLoginUrl(candidate) {
    try {
      const url = new URL(candidate);
      return url.protocol === 'https:' && LOGIN_HOSTS.includes(url.hostname.toLowerCase()) ? url.href : null;
    } catch { return null; }
  }
  function renderConnection() {
    const connection = chosen(), canEdit = editable(connection), box = el('connection-fields');
    const provider = pendingProvider();
    box.replaceChildren(); recommendation = null;
    clearTimeout(loginTimer); login = null; accountState = null;
    if (value('connection') && canEdit) {
      field(box, 'name', 'name', 'text', connection?.name || '');
      if (provider === 'chatgpt_account') renderAccountPanel(box, connection);
      else {
        field(box, 'url', 'url', 'url', connection?.base_url || '');
        const key = field(box, 'key', 'key', 'password'); key.autocomplete = 'new-password';
        label('p', box, 'keyInfo', 'small text-muted');
      }
      if (currentUser.is_admin) {
        // A personal ChatGPT sign-in has no sharing controls at all; the server
        // rejects them as well.
        if (provider !== 'chatgpt_account') {
          field(box, 'shared', 'shared', 'checkbox', connection?.shared);
          userSelect(box, 'connection-users', 'users', connection?.allowed_user_ids || [], true);
        }
        featureChecks(box, 'connection-function', connection?.functions || settings.functions || []);
      }
      el('url')?.addEventListener('input', destination);
    } else if (connection) label('p', box, 'provided');
    el('model-controls').hidden = !canEdit || !value('connection');
    el('delete-connection').hidden = !connection || !canEdit;
    el('model').value = (canEdit && preferences.connection_id === connection?.id && preferences.model_id) || connection?.model_id || '';
    el('model').readOnly = !canEdit;
    el('advanced').hidden = provider === 'chatgpt_account';
    el('token-parameter').value = connection?.token_parameter || 'max_tokens';
    el('token-parameter').disabled = !canEdit || provider === 'chatgpt_account';
    renderCapabilities(Object.values(connection?.capabilities || {}));
    el('recommendation').disabled = true;
    el('models').replaceChildren(); renderModels(connection?.models || []); destination();
  }
  function renderAccountPanel(box, connection) {
    const panel = node('div', box, undefined, 'border rounded p-3 mb-3');
    panel.id = 'ai-account-panel';
    label('p', panel, 'chatgptDisclosure', 'small text-muted');
    node('div', panel).id = 'ai-account-state';
    const controls = node('div', panel);
    button(controls, 'link-start', 'linkStart', startLink, 'primary');
    button(controls, 'link-cancel', 'linkCancel', cancelLink, 'outline-secondary');
    button(controls, 'account-refresh', 'accountRefresh', loadAccount);
    button(controls, 'unlink', 'unlink', unlink, 'outline-danger');
    node('div', panel).id = 'ai-link-state';
    renderAccount(connection);
  }
  // Captions carry their translation key so the shared language switch
  // re-renders them; only the value itself is plain text.
  function captioned(parent, key, value) {
    const row = node('p', parent, undefined, 'mb-1');
    label('span', row, key);
    node('span', row, `: ${value}`);
    return row;
  }
  function renderAccount(connection) {
    const box = el('account-state');
    if (!box) return;
    box.replaceChildren();
    // A refreshed account read is newer than the stored connection record, so a
    // sign-in that no longer authenticates must not keep showing as connected.
    const linked = accountState ? Boolean(accountState.linked) : Boolean(connection?.account?.linked);
    label('p', box, linked ? 'accountLinked' : 'accountNotLinked', linked ? 'mb-1 fw-semibold' : 'mb-1 text-muted');
    if (linked) {
      captioned(box, 'accountLabel', (accountState?.label ?? connection?.account?.label) || tr('unknown'));
      captioned(box, 'plan', (accountState?.plan_type ?? connection?.account?.plan_type) || tr('unknown'));
      renderQuota(box);
    }
    if (el('link-start')) el('link-start').hidden = linked;
    if (el('unlink')) el('unlink').hidden = !linked;
    if (el('account-refresh')) el('account-refresh').hidden = !linked;
    if (el('link-cancel')) el('link-cancel').hidden = !login || login.status !== 'pending';
  }
  // Quota is shown only where the documented interface reported it; anything
  // else stays explicitly unknown, with no prices and no derived request counts.
  function renderQuota(box) {
    const quota = accountState?.quota;
    if (!quota?.known) { label('p', box, 'quotaUnknown', 'mb-1 text-muted'); return; }
    for (const key of ['primary', 'secondary']) {
      const window_ = quota[key];
      if (!window_) continue;
      captioned(box, 'quotaUsed', `${Math.round(window_.used_percent)}%`);
      if (window_.window_minutes) captioned(box, 'quotaWindow', `${window_.window_minutes} min`);
      if (window_.resets_at) captioned(box, 'quotaResets', new Date(window_.resets_at * 1000).toLocaleString());
    }
    if (quota.ordinary_usage_allowed === false) label('p', box, 'quotaBlocked', 'mb-1 text-warning');
  }
  function renderLogin(connectionId) {
    const box = el('link-state');
    if (!box) return;
    box.replaceChildren();
    if (!login) return;
    if (login.status === 'pending') {
      const url = safeLoginUrl(login.verification_url);
      label('p', box, 'linkPending', 'mb-1');
      if (url) {
        const anchor = node('a', box, url, 'd-block mb-1');
        anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      } else label('p', box, 'linkTargetBlocked', 'mb-1 text-danger');
      node('p', node('p', box, undefined, 'mb-1'), `${tr('linkCode')}: ${login.user_code || ''}`, 'fs-5 fw-bold');
    } else label('p', box, loginStateKey(login), login.status === 'completed' ? 'mb-1 text-success' : 'mb-1 text-warning');
    if (el('link-cancel')) el('link-cancel').hidden = login.status !== 'pending';
    void connectionId;
  }
  function loginStateKey(state) {
    const map = {
      ai_codex_login_expired: 'linkExpired',
      ai_codex_login_cancelled: 'linkCancelled',
      ai_codex_login_superseded: 'linkSuperseded',
      ai_codex_login_interrupted: 'linkInterrupted',
      ai_codex_login_rejected: 'linkRejected',
      ai_codex_account_already_linked: 'alreadyLinked',
      ai_codex_account_unavailable: 'accountUnavailable',
      ai_codex_account_unidentified: 'accountUnidentified',
      ai_codex_unexpected_auth: 'unexpectedAuth',
      ai_codex_credentials_unavailable: 'linkFailed'
    };
    if (state.status === 'completed') return 'linkDone';
    return map[state.error_code] || (state.status === 'cancelled' ? 'linkCancelled' : state.status === 'expired' ? 'linkExpired' : 'linkFailed');
  }
  async function refreshConnections() {
    const selection = value('connection');
    connections = list(await api('/connections'), 'connections');
    if (el('connection')) el('connection').value = selection;
  }
  async function startLink() {
    await enableSetup();
    const connection = await saveConnection();
    if (!connection) throw {code: 'AI_INVALID_INPUT'};
    status('running', 'setup');
    login = await api(`/connections/${encodeURIComponent(connection.id)}/link`, 'POST', {});
    renderLogin(connection.id); renderAccount(connection);
    status('linkPending', 'setup');
    pollLink(connection.id);
  }
  function pollLink(connectionId, failures = 0) {
    clearTimeout(loginTimer);
    if (!login || login.status !== 'pending') return;
    const stamp = generation, identity = actor(), token = sessionToken;
    loginTimer = setTimeout(async () => {
      // A late poll from a previous session or account must never be applied.
      if (stamp !== generation || identity !== actor() || token !== getToken() || !login) return;
      try {
        const state = await api(`/connections/${encodeURIComponent(connectionId)}/link/${encodeURIComponent(login.id)}`);
        if (!state || stamp !== generation || !login || state.id !== login.id) return;
        login = {...login, ...state};
        renderLogin(connectionId);
        if (state.status === 'pending') return pollLink(connectionId, 0);
        await refreshConnections();
        renderAccount(chosen());
        if (state.status === 'completed') { await loadAccount(); status('linkDone', 'setup'); }
        else status(loginStateKey(state), 'setup');
      } catch (error) {
        if (stamp !== generation || !login) return;
        const key = errorKey(error);
        // The server drops an attempt that stops being polled, so a transient
        // failure must not abandon a sign-in the account holder is completing.
        // A refusal or a missing attempt is final and stops immediately.
        if (['denied', 'off'].includes(key) || /NOT_FOUND/.test(String(error.response?.code || error.code || '').toUpperCase())
          || failures + 1 >= MAX_LINK_POLL_FAILURES) {
          status(key, 'setup');
          return;
        }
        status('linkRetrying', 'setup');
        pollLink(connectionId, failures + 1);
      }
    }, 3000);
  }
  async function cancelLink() {
    const connection = chosen();
    if (!connection || !login) return;
    clearTimeout(loginTimer);
    const result = await api(`/connections/${encodeURIComponent(connection.id)}/link/${encodeURIComponent(login.id)}/cancel`, 'POST', {});
    login = {...login, ...result};
    renderLogin(connection.id);
    // A completion can win the race; report what actually happened.
    if (login.status === 'completed') { await refreshConnections(); await loadAccount(); }
    renderAccount(chosen());
    status(loginStateKey(login), 'setup');
  }
  async function unlink() {
    const connection = chosen();
    if (!connection || !confirm(tr('confirmUnlink'))) return;
    clearTimeout(loginTimer); login = null;
    const result = await api(`/connections/${encodeURIComponent(connection.id)}/unlink`, 'POST', {});
    accountState = null;
    await refreshConnections();
    renderConnection();
    status(result?.remote_logout === false ? 'unlinkRemoteFailed' : 'unlinkDone', 'setup');
  }
  async function loadAccount() {
    const connection = chosen();
    if (!connection?.account?.linked) { accountState = null; renderAccount(connection); return; }
    status('running', 'setup');
    accountState = await api(`/connections/${encodeURIComponent(connection.id)}/account`);
    renderAccount(connection);
    // A refresh that reports the account as no longer connected leaves the
    // refreshed state on screen — re-rendering the connection would fall back to
    // the stored record and show it as connected again.
    status(accountState && !accountState.linked ? 'notLinked' : 'saved', 'setup');
  }
  function destination() {
    if (pendingProvider() === 'chatgpt_account') { el('destination').textContent = tr('managedDestination'); return; }
    let target = chosen()?.base_url || '';
    if (el('url')) {
      try { const url = new URL(value('url')); url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '').replace(/\/$/, ''); target = url.toString(); }
      catch { target = ''; }
    }
    el('destination').textContent = target || tr('unknown');
  }
  function renderModels(models) {
    const selected = new Set([...el('models').selectedOptions].map(item => item.value));
    const current = value('model') || chosen()?.model_id;
    if (!selected.size && current) selected.add(current);
    const entries = new Map(models.map(model => [typeof model === 'string' ? model : model.id, typeof model === 'string' ? {id: model} : model]));
    for (const id of selected) if (!entries.has(id)) entries.set(id, {id, missing: true});
    const ordered = [...entries.values()].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || Number(b.candidate === 'text') - Number(a.candidate === 'text') || a.id.localeCompare(b.id));
    if (!selected.size) {
      for (const model of ordered.filter(model => model.candidate === 'text').slice(0, 3)) selected.add(model.id);
      if (ordered.length === 1 && ordered[0].candidate !== 'other') selected.add(ordered[0].id);
    }
    el('models').replaceChildren();
    for (const model of ordered) option(el('models'), model.id, `${model.id}${model.missing ? ` (${tr('notListed')})` : ''}`).selected = selected.has(model.id);
  }
  function adoptRecommendation() {
    if (!recommendation) return;
    el('model').value = recommendation;
    const profile = chosen()?.capabilities?.[recommendation];
    if (profile?.token_parameter) el('token-parameter').value = profile.token_parameter;
  }
  function renderCapabilities(models) {
    const box = el('capabilities'); box.replaceChildren();
    if (!models.length) return;
    const table = node('table', node('div', box, undefined, 'table-responsive'), undefined, 'table table-sm table-striped');
    const head = node('tr', node('thead', table));
    for (const key of ['model', 'chat', 'structured', 'testStatus', 'tokenParameter']) label('th', head, key).scope = 'col';
    const body = node('tbody', table);
    for (const model of models) {
      const row = node('tr', body); node('td', row, model.id);
      label('td', row, model.chat ? 'yes' : model.status === 'unverified' ? 'unknown' : 'no');
      label('td', row, model.structured ? 'yes' : model.error_code === 'AI_INVALID_RESPONSE' ? 'unknown' : 'no');
      label('td', row, ['compatible', 'json_fallback', 'incompatible', 'unverified'].includes(model.status) ? model.status : 'unknown');
      node('td', row, model.token_parameter || tr('unknown'));
    }
  }
  async function enableSetup() {
    if (!settings.enabled || !checked('enabled')) throw {code: 'AI_DISABLED'};
    preferences = await api('/preferences', 'PUT', {enabled: true});
  }
  async function saveConnection(selectModel = false) {
    const connection = chosen();
    const selection = value('connection');
    const provider = pendingProvider();
    if (!editable(connection)) return connection;
    if (!value('name')) throw {code: 'AI_INVALID_INPUT'};
    const input = {name: value('name'), enabled: true};
    // The provider is fixed at creation; an existing connection never sends it.
    if (!connection) input.provider = provider;
    if (provider === 'chatgpt_account') {
      // No user-supplied address, key or token parameter exists for a managed
      // ChatGPT sign-in, and the server rejects them.
      if (currentUser.is_admin) input.functions = selectedFeatures('connection-function');
    } else {
      if (!value('url')) throw {code: 'AI_INVALID_INPUT'};
      Object.assign(input, {base_url: value('url'), token_parameter: value('token-parameter')});
      if (value('key')) input.api_key = value('key');
      if (currentUser.is_admin) Object.assign(input, {shared: checked('shared'), allowed_user_ids: ids('connection-users'), functions: selectedFeatures('connection-function')});
    }
    if (selectModel) input.model_id = value('model') || null;
    try {
      const saved = await api(`/connections${connection ? `/${encodeURIComponent(connection.id)}` : ''}`, connection ? 'PUT' : 'POST', input);
      if (selection !== value('connection')) throw {code: 'AI_CONNECTION_CHANGED'};
      connections = connections.filter(item => item.id !== saved.id).concat(saved);
      if (!connection) option(el('connection'), saved.id, saved.name);
      el('connection').value = saved.id;
      // Show the server-normalized destination before any external request.
      if (el('url')) el('url').value = saved.base_url || '';
      destination();
      return saved;
    } finally { if (el('key')) el('key').value = ''; input.api_key = undefined; }
  }
  function buildWork() {
    const box = section('work', true);
    const select = field(box, 'feature', 'feature', 'select');
    for (const feature of features) option(select, feature, '', feature).disabled = !(settings.functions || []).includes(feature);
    const diagnosticNote = label('p', box, 'diagnosticScope', 'small text-muted'); diagnosticNote.hidden = true;
    if (currentUser.is_admin) userSelect(box, 'user', 'user', typeof selectedUserId !== 'undefined' && selectedUserId ? [selectedUserId] : []);
    field(box, 'prompt', 'prompt', 'textarea');
    const scope = node('details', box); label('summary', scope, 'scope');
    field(scope, 'full-list', 'fullList', 'checkbox', false);
    field(scope, 'channel-ids', 'channelIds'); field(scope, 'category-id', 'categoryId', 'number');
    field(scope, 'pinned', 'pinned');
    field(scope, 'keep-first', 'keepFirst', 'number', 0); field(scope, 'override', 'override');
    const language = field(scope, 'language', 'language', 'select');
    for (const [code, name] of [['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['el', 'Ελληνικά']]) option(language, code, name);
    language.value = preferences.language || currentLang;
    field(scope, 'timezone', 'timezone', 'text', preferences.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    const op = field(box, 'operation', 'operation', 'select');
    for (const operation of ['translate', 'summarize', 'tags']) option(op, operation, '', operation);
    const source = field(box, 'text-source', 'descriptionSource', 'select');
    option(source, 'original', '', 'originalDescription'); option(source, 'epg', '', 'epgDescription');
    const programBox = node('div', box); programBox.id = 'ai-program-options'; programBox.hidden = true;
    button(programBox, 'load-programs', 'loadPrograms', loadPrograms);
    const programSelect = field(programBox, 'program', 'program', 'select');
    const description = node('p', programBox, '', 'text-muted'); description.id = 'ai-program-description';
    source.addEventListener('change', () => { resetPrograms(); programBox.hidden = source.value !== 'epg'; });
    programSelect.addEventListener('change', () => { description.textContent = programSelect.value === '' ? '' : programs[Number(programSelect.value)]?.description || ''; });
    field(box, 'filters', 'filters', 'textarea', '{}');
    select.addEventListener('change', () => {
      diagnosticNote.hidden = select.value !== 'diagnose';
      beginResult(); clearTimeout(timer); jobId = null;
      conversationId = null; filterBaseline = {}; el('filters').value = '{}'; nextOffset = 0;
      el('operation').parentElement.hidden = select.value !== 'text';
      source.parentElement.hidden = select.value !== 'text';
      programBox.hidden = select.value !== 'text' || source.value !== 'epg';
      resetPrograms();
      el('filters').parentElement.hidden = select.value !== 'search';
      el('new-search').hidden = select.value !== 'search';
    });
    button(box, 'run', 'run', () => { nextOffset = 0; return startJob(); }, 'primary');
    button(box, 'refresh-job', 'refreshStatus', () => { status('running'); return poll(); }).hidden = true;
    button(box, 'cancel', 'cancel', async () => {
      if (!jobId) return;
      const id = jobId, resultStamp = resultGeneration;
      let result;
      try { result = await api(`/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}, resultStamp); }
      catch (error) { if (resultStamp !== resultGeneration || jobId !== id) return; throw error; }
      if (resultStamp !== resultGeneration || jobId !== id) return;
      clearTimeout(timer);
      if (result.status === 'cancelled') { jobId = null; el('refresh-job').hidden = true; status('cancelled'); }
      else await poll();
    });
    button(box, 'new-search', 'newSearch', () => { beginResult(); clearTimeout(timer); jobId = null; conversationId = null; filterBaseline = {}; nextOffset = 0; el('filters').value = '{}'; el('prompt').value = ''; });
    progress(box, 'work');
    const results = node('section', box); results.id = 'ai-result'; results.setAttribute('aria-live', 'polite'); results.tabIndex = -1;
    const preview = node('section', box); preview.id = 'ai-proposal';
    for (const id of ['user', 'channel-ids']) el(id)?.addEventListener('input', () => {
      resetPrograms(); beginResult(); clearTimeout(timer); jobId = null;
      conversationId = null; filterBaseline = {}; el('filters').value = '{}';
    });
    el('timezone').addEventListener('input', resetPrograms);
    select.dispatchEvent(new Event('change'));
  }
  function resetPrograms() {
    programGeneration++; programs = []; programScope = '';
    el('program')?.replaceChildren();
    if (el('program')) option(el('program'), '', '', 'choose');
    el('program-description')?.replaceChildren();
  }
  function programTarget() {
    return {channel: ids('channel-ids')[0], user: currentUser.is_admin ? Number(value('user')) : currentUser.id, timezone: value('timezone')};
  }
  async function loadPrograms() {
    resetPrograms();
    const stamp = programGeneration, target = programTarget();
    if (!Number.isSafeInteger(target.user) || target.user <= 0) { el('user')?.focus(); throw {code: 'AI_TARGET_USER_REQUIRED'}; }
    if (!target.channel) throw {code: 'AI_INVALID_INPUT'};
    const query = new URLSearchParams({timezone: target.timezone});
    if (currentUser.is_admin) query.set('user_id', target.user);
    let result;
    try { result = await api(`/channels/${target.channel}/programs?${query}`); }
    catch (error) { if (stamp !== programGeneration) return; throw error; }
    if (stamp !== programGeneration || JSON.stringify(target) !== JSON.stringify(programTarget())) return;
    programs = list(result, 'items'); programScope = JSON.stringify(target);
    for (const [index, program] of programs.entries()) option(el('program'), String(index), `${program.title} — ${program.local_start}`);
    if (!programs.length) label('span', el('program-description'), 'empty');
    else if (result.truncated) label('span', el('program-description'), 'programsLimited');
  }
  function payload() {
    const result = {feature: value('feature'), prompt: value('prompt'), language: value('language'), timezone: value('timezone'), connection_id: value('connection'), channel_ids: ids('channel-ids'), pinned_ids: ids('pinned'), selected_ids: ids('override'), keep_first: Number(value('keep-first') || 0), full_list: checked('full-list'), offset: nextOffset};
    if (currentUser.is_admin && (value('user') || result.feature !== 'diagnose')) {
      result.user_id = Number(value('user'));
      if (!Number.isSafeInteger(result.user_id) || result.user_id <= 0) { el('user').focus(); throw {code: 'AI_TARGET_USER_REQUIRED'}; }
    }
    if (value('category-id')) result.category_id = Number(value('category-id'));
    if (result.feature === 'search') {
      try { result.filters = JSON.parse(value('filters') || '{}'); } catch { throw {code: 'AI_INVALID_INPUT'}; }
      if (!result.filters || Array.isArray(result.filters) || typeof result.filters !== 'object') throw {code: 'AI_INVALID_INPUT'};
      if (conversationId) {
        result.conversation_id = conversationId;
        const edited = result.filters;
        result.filters = Object.fromEntries([...new Set([...Object.keys(filterBaseline), ...Object.keys(edited)])]
          .filter(key => JSON.stringify(filterBaseline[key]) !== JSON.stringify(edited[key]))
          .map(key => [key, Object.hasOwn(edited, key) ? edited[key] : null]));
        if (!Object.keys(result.filters).length) delete result.filters;
      }
    }
    if (result.feature === 'text') {
      result.operation = value('operation'); result.provider_channel_id = result.channel_ids[0];
      if (value('text-source') === 'epg') {
        const item = value('program') !== '' && programs[Number(value('program'))];
        if (!item?.program || item.provider_channel_id !== result.provider_channel_id || programScope !== JSON.stringify(programTarget())) throw {code: 'AI_PROGRAM_REQUIRED'};
        const {channel_id, source_type, source_id, start} = item.program;
        result.program = {channel_id, source_type, source_id, start};
      }
    }
    return result;
  }
  async function startJob() {
    if (jobId) return;
    if (!settings.enabled || !preferences.enabled) { status('off'); return; }
    const input = payload(); input.idempotency_key = crypto.randomUUID();
    const resultStamp = beginResult();
    status('queued');
    const job = await api('/jobs', 'POST', input, resultStamp);
    if (resultStamp !== resultGeneration) return;
    jobId = job.id; status('queued');
    await poll();
  }
  async function poll() {
    if (!jobId) return;
    const id = jobId, resultStamp = resultGeneration;
    clearTimeout(timer); el('refresh-job').hidden = true;
    let job;
    try { job = await api(`/jobs/${encodeURIComponent(id)}`, 'GET', undefined, resultStamp); }
    catch (error) {
      if (jobId !== id || resultStamp !== resultGeneration) return;
      el('refresh-job').hidden = false;
      throw error;
    }
    if (jobId !== id || resultStamp !== resultGeneration) return;
    if (['completed', 'succeeded', 'done'].includes(job.status)) {
      jobId = null; status('completed'); await showResult(job.result || {});
    } else if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
      jobId = null; status(job.status === 'cancelled' ? 'cancelled' : errorKey({code: job.error_code}));
    } else { status(job.status === 'queued' ? 'queued' : 'running'); timer = setTimeout(() => run(poll), 1200); }
  }
  async function showResult(result) {
    const resultStamp = beginResult();
    const box = el('result');
    label('h3', box, 'result', 'h5');
    node('p', box, result.summary || tr(result.explanation_unavailable ? 'localOnly' : 'empty'));
    const coverage = result.coverage || {};
    for (const [key, shown, total] of [
      ['analyzedCount', coverage.processed, coverage.total],
      ['itemPreviewCount', coverage.items_shown, coverage.items_total],
      ['findingPreviewCount', coverage.findings_shown, coverage.findings_total],
      ['diagnosticPreviewCount', coverage.diagnostic_entries_shown, coverage.diagnostic_entries_total],
      ['diffPreviewCount', result.diff?.preview?.shown, result.diff?.preview?.total]
    ]) {
      if (!Number.isFinite(shown) || !Number.isFinite(total)) continue;
      const count = node('p', box); label('span', count, key); node('span', count, `: ${shown} / ${total}`);
    }
    for (const key of ['items', 'findings', 'diff', 'text', 'coverage']) {
      if (key === 'findings' && result.feature === 'diagnose' && Array.isArray(result.findings)) {
        for (const certainty of ['proven', 'possible', 'unknown']) {
          const findings = result.findings.filter(finding => finding.certainty === certainty);
          if (!findings.length) continue;
          label('h4', box, certainty, 'h6'); node('pre', box, printable(findings));
        }
        continue;
      }
      if (result[key] !== undefined) node('pre', box, printable(result[key]));
    }
    if (result.feature === 'diagnose') label('p', box, 'diagnosticScope', 'small text-muted');
    conversationId = result.conversation_id || null;
    filterBaseline = result.filters || {};
    el('filters').value = printable(filterBaseline);
    if (coverage.partial || coverage.results_partial || coverage.epg_review_partial || coverage.diagnostic_entries_partial) {
      label('p', box, 'partial', 'alert alert-warning');
      if (Number.isInteger(result.coverage.next_offset)) button(box, 'next', 'next', () => { nextOffset = result.coverage.next_offset; return startJob(); });
    }
    if (result.enrichment_id) {
      const enrichment = await api(`/enrichments/${encodeURIComponent(result.enrichment_id)}`, 'GET', undefined, resultStamp);
      if (resultStamp !== resultGeneration) return;
      node('pre', box, printable(enrichment));
    }
    if (result.proposal_id) {
      const fresh = await api(`/proposals/${encodeURIComponent(result.proposal_id)}`, 'GET', undefined, resultStamp);
      if (resultStamp !== resultGeneration) return;
      proposal = fresh; await renderProposal(fresh, resultStamp);
    }
    if (resultStamp === resultGeneration) box.focus();
  }
  async function renderProposal(activeProposal, resultStamp) {
    if (resultStamp !== resultGeneration) return;
    const box = el('proposal'); box.replaceChildren();
    appliedActionIds = []; renderRuleActions();
    let confirmation;
    label('h3', box, 'preview', 'h5'); node('p', box, activeProposal.summary || '');
    for (const action of activeProposal.actions || []) {
      const card = node('div', box, undefined, 'border rounded p-3 mb-2');
      const toggle = field(card, `action-${action.id}`, 'select', 'checkbox', false);
      toggle.dataset.aiAction = action.id;
      if (action.target_name) node('h4', card, action.target_name, 'h6');
      node('p', card, action.label || action.type, 'fw-semibold');
      const row = node('div', card, undefined, 'row');
      for (const key of ['before', 'after']) { const col = node('div', row, undefined, 'col-md-6'); label('h4', col, key, 'h6'); node('pre', col, printable(action[key])); }
      toggle.addEventListener('change', () => {
        if (toggle.checked) for (const dependency of action.dependencies || []) { if (el(`action-${dependency}`)) el(`action-${dependency}`).checked = true; }
      });
    }
    if (activeProposal.change_id) {
      const change = await api(`/changes/${encodeURIComponent(activeProposal.change_id)}`, 'GET', undefined, resultStamp);
      if (resultStamp !== resultGeneration) return;
      box.querySelectorAll('input').forEach(input => { input.disabled = true; });
      if (change.status === 'applied') { changeId = change.id; appliedActionIds = change.action_ids || []; renderRuleActions(); renderUndo(box, change.id, resultStamp); }
      else label('p', box, 'undone');
      return;
    }
    button(box, 'apply', 'apply', async () => {
      if (resultStamp !== resultGeneration) return;
      const actionIds = [...box.querySelectorAll('[data-ai-action]:checked')].map(input => input.dataset.aiAction);
      if (!actionIds.length) throw {code: 'AI_INVALID_INPUT'};
      if (!confirm(tr('confirm'))) return;
      const selection = actionIds.slice().sort().join(',');
      if (confirmation?.selection !== selection) confirmation = {selection, key: crypto.randomUUID()};
      const result = await api(`/proposals/${encodeURIComponent(activeProposal.id)}/apply`, 'POST', {action_ids: actionIds, idempotency_key: confirmation.key}, resultStamp);
      if (resultStamp !== resultGeneration) return;
      changeId = result.change_id;
      appliedActionIds = actionIds; renderRuleActions();
      box.querySelectorAll('input').forEach(input => { input.disabled = true; });
      el('apply').hidden = true; status('saved');
      renderUndo(box, result.change_id, resultStamp);
    }, 'primary');
  }
  function renderUndo(box, id, resultStamp) {
    const control = button(box, 'undo', 'undo', async () => {
      if (resultStamp !== resultGeneration) return;
      await api(`/changes/${encodeURIComponent(id)}/undo`, 'POST', {}, resultStamp);
      if (resultStamp !== resultGeneration) return;
      changeId = null; appliedActionIds = []; renderRuleActions(); control.hidden = true; status('undone');
    });
  }
  function buildRules() {
    const box = section('rules');
    let draft;
    field(box, 'rule-action', 'confirmedRename', 'select');
    field(box, 'rule-name', 'ruleName');
    const operation = field(box, 'rule-operation', 'operation', 'select');
    for (const key of ['strip_prefix', 'replace_literal']) option(operation, key, '', key);
    field(box, 'rule-match', 'match'); field(box, 'rule-replacement', 'replacement'); field(box, 'rule-exceptions', 'exceptions');
    field(box, 'rule-enabled', 'automatic', 'checkbox', false);
    const input = () => {
      const action = proposal?.actions.find(item => item.id === value('rule-action') && item.type === 'rename_channel' && appliedActionIds.includes(item.id));
      if (!changeId || !action) throw {code: 'AI_RULE_REQUIRES_CONFIRMATION'};
      return {proposal_id: proposal.id, action_id: action.id, name: value('rule-name'), operation: value('rule-operation'), match: value('rule-match'), replacement: value('rule-replacement'), exceptions: value('rule-exceptions').split(',').map(part => part.trim()).filter(Boolean), ...(currentUser.is_admin ? {user_id: Number(value('user'))} : {})};
    };
    button(box, 'rule-preview', 'rulePreview', async () => {
      const resultStamp = resultGeneration;
      if (draft?.resultStamp !== resultStamp) draft = null;
      const data = input();
      const saved = await api(`/rules${draft ? `/${encodeURIComponent(draft.id)}` : ''}`, draft ? 'PUT' : 'POST', {...data, enabled: false}, resultStamp);
      if (resultStamp !== resultGeneration) return;
      draft = {id: saved.id, signature: JSON.stringify(data), resultStamp};
      el('rule-preview-result').textContent = printable(saved.preview || []);
      checked('rule-enabled') && (el('rule-enabled').checked = false);
      status('saved');
    });
    node('pre', box).id = 'ai-rule-preview-result';
    button(box, 'save-rule', 'saveRule', async () => {
      const data = input();
      if (!draft || draft.signature !== JSON.stringify(data)) throw {code: 'AI_RULE_PREVIEW_REQUIRED'};
      await api(`/rules/${encodeURIComponent(draft.id)}`, 'PUT', {...data, enabled: checked('rule-enabled')});
      await loadRules(); status('saved');
    });
    button(box, 'refresh-rules', 'refresh', loadRules);
    node('div', box).id = 'ai-rules';
  }
  function renderRuleActions() {
    const select = el('rule-action');
    if (!select) return;
    select.replaceChildren();
    const actions = (proposal?.actions || []).filter(action => action.type === 'rename_channel' && appliedActionIds.includes(action.id));
    if (actions.length !== 1) option(select, '', '', 'choose');
    for (const action of actions) option(select, action.id, action.target_name || action.label || action.id);
    select.disabled = !actions.length;
  }
  async function loadRules() {
    const rules = list(await api(`/rules${currentUser.is_admin ? `?user_id=${encodeURIComponent(value('user'))}` : ''}`), 'rules');
    const box = el('rules'); box.replaceChildren();
    for (const rule of rules) {
      const row = node('div', box, undefined, 'border rounded p-2 mb-2'); node('p', row, rule.name);
      const enabled = field(row, `rule-active-${rule.id}`, 'automatic', 'checkbox', rule.enabled);
      button(row, `rule-save-${rule.id}`, 'save', async () => { await api(`/rules/${encodeURIComponent(rule.id)}`, 'PUT', {...rule, enabled: enabled.checked}); status('saved'); });
      button(row, `rule-delete-${rule.id}`, 'delete', async () => { if (confirm(tr('confirmDelete'))) { await api(`/rules/${encodeURIComponent(rule.id)}`, 'DELETE'); await loadRules(); } }, 'outline-danger');
    }
    if (!rules.length) label('p', box, 'empty');
  }
  function buildHistory() {
    const box = section('history');
    button(box, 'refresh-history', 'refresh', async () => {
      const [jobs, changes, usage] = await Promise.all([api('/jobs'), api('/changes'), api('/usage')]);
      el('history').replaceChildren();
      for (const job of list(jobs, 'jobs')) {
        button(el('history'), `history-${job.id}`, features.includes(job.feature) ? job.feature : 'result', async () => {
          const resultStamp = beginResult(); clearTimeout(timer); jobId = null;
          const fresh = await api(`/jobs/${encodeURIComponent(job.id)}`, 'GET', undefined, resultStamp);
          if (resultStamp !== resultGeneration) return;
          if (fresh.result) await showResult(fresh.result);
          else if (['queued', 'running'].includes(fresh.status)) { jobId = fresh.id; await poll(); }
          else status(fresh.status === 'cancelled' ? 'cancelled' : 'failed');
        });
      }
      for (const change of list(changes, 'changes')) {
        const row = node('div', el('history'), undefined, 'border rounded p-2 mb-2');
        label('span', row, features.includes(change.feature) ? change.feature : 'result'); node('span', row, ' · ');
        label('span', row, change.status === 'undone' ? 'undone' : 'applied');
        if (change.created_at) node('p', row, new Date(change.created_at).toLocaleString());
        button(row, `change-${change.id}`, 'openChange', async () => {
          const resultStamp = beginResult(); clearTimeout(timer); jobId = null;
          conversationId = null; filterBaseline = {}; el('filters').value = '{}';
          const fresh = await api(`/changes/${encodeURIComponent(change.id)}`, 'GET', undefined, resultStamp);
          if (resultStamp !== resultGeneration) return;
          const result = el('result'); label('h3', result, 'change', 'h5');
          label('p', result, fresh.status === 'undone' ? 'undone' : 'applied');
          for (const diff of fresh.diffs || []) {
            if (diff.id) node('h4', result, String(diff.id), 'h6');
            for (const key of ['before', 'after']) { label('h4', result, key, 'h6'); node('pre', result, printable(diff[key])); }
          }
          if (fresh.status === 'applied') renderUndo(el('proposal'), fresh.id, resultStamp);
          result.focus();
        });
      }
      node('pre', el('history'), JSON.stringify(usage, (_key, item) => item === null ? tr('unknown') : item, 2));
    });
    button(box, 'clear-history', 'clearHistory', async () => {
      if (!confirm(tr('confirmDelete'))) return;
      await api('/history', 'DELETE');
      beginResult();
      conversationId = null; filterBaseline = {}; jobId = null; clearTimeout(timer);
      el('history').replaceChildren(); el('result').replaceChildren(); el('filters').value = '{}'; status('saved');
    }, 'outline-danger');
    node('div', box).id = 'ai-history';
  }
  function syncActor() { if (owner && (owner !== actor() || sessionToken !== getToken())) clear(); }
  window.addEventListener('storage', event => { if (event.key === 'jwt_token' || event.key === null) syncActor(); });
  return {open, clear, syncActor};
})();
