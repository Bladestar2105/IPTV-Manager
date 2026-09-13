import { expect, test } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
  .match(/(?:async )?function (?:handleLogout|isAuthenticationFailure)\([^)]*\) \{[\s\S]*?\n\}/g).join('\n');

function browser(fetch) {
  let token = 'current-session';
  const notices = [];
  const context = vm.createContext({
    fetch, AbortSignal, getToken: () => token, removeToken: () => { token = null; },
    currentUser: { id: 1 }, selectedUser: null, selectedUserId: null, selectedCategoryId: null,
    globalStatsInterval: null, clearInterval, clearSessionSensitiveState() {}, showLoginModal() {},
    showToast: (...args) => notices.push(args), t: key => key,
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) }
  });
  vm.runInContext(source, context);
  return { context, notices, token: () => token, changeSession: value => { token = value; } };
}

test('logout ends pending links with its bearer before discarding the browser session', async () => {
  let acknowledge;
  const requests = [];
  const app = browser((url, options) => {
    requests.push({ url, options });
    return new Promise(resolve => { acknowledge = resolve; });
  });
  const pending = app.context.handleLogout();
  expect(app.token()).toBe('current-session');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ url: '/api/ai/codex/session/end', options: {
    method: 'POST', headers: { Authorization: 'Bearer current-session', 'Content-Type': 'application/json' }
  } });
  acknowledge({ ok: true });
  await pending;
  expect(app.token()).toBeNull();
  expect(app.context.currentUser).toBeNull();
});

test.each(['network', 'server'])('failed %s cancellation keeps logout retryable', async failure => {
  const app = browser(async () => {
    if (failure === 'network') throw new Error('offline');
    return { ok: false, status: 500 };
  });
  await app.context.handleLogout();
  expect(app.token()).toBe('current-session');
  expect(app.context.currentUser).toEqual({ id: 1 });
  expect(app.notices[0]?.[1]).toBe('danger');
});

test.each([
  [401, 'Token revoked (password changed)'],
  [401, 'No token provided'],
  [401, 'User is inactive or deleted'],
  [403, 'Invalid or expired token'],
  [403, 'WebUI access revoked'],
  [403, 'Access denied from your region']
])('an unusable session can still be cleared locally (%s %s)', async (status, error) => {
  const app = browser(async () => ({ ok: false, status, json: async () => ({ error }) }));
  await app.context.handleLogout();
  expect(app.token()).toBeNull();
  expect(app.context.currentUser).toBeNull();
});

test.each([
  [403, 'Access denied'],
  [403, 'AI_CODEX_UNAVAILABLE']
])('a non-authentication denial does not acknowledge cancellation (%s %s)', async (status, error) => {
  const app = browser(async () => ({ ok: false, status, json: async () => ({ error }) }));
  await app.context.handleLogout();
  expect(app.token()).toBe('current-session');
  expect(app.notices[0]?.[1]).toBe('danger');
});

test('a delayed logout acknowledgement cannot clear a newer browser session', async () => {
  let acknowledge;
  const app = browser(() => new Promise(resolve => { acknowledge = resolve; }));
  const pending = app.context.handleLogout();
  app.changeSession('new-session');
  acknowledge?.({ ok: true });
  await pending;
  expect(app.token()).toBe('new-session');
  expect(app.context.currentUser).toEqual({ id: 1 });
});
