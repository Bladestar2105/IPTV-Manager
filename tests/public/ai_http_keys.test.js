import { expect, test } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

test('AI jobs create unique server-compatible idempotency keys when LAN HTTP has no randomUUID', async () => {
  const source = fs.readFileSync(new URL('../../public/ai.js', import.meta.url), 'utf8');
  const names = ['newIdempotencyKey', 'startJob'];
  const methods = names.map(name => source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0] || '').join('\n');
  const keys = [];
  const context = vm.createContext({
    crypto: { getRandomValues: values => webcrypto.getRandomValues(values) }, Uint8Array,
    submittingJob: false, jobId: null, submittingLink: false, login: null, pendingContextWrites: new Set(),
    settings: { enabled: true }, preferences: { enabled: true }, generation: 1, resultGeneration: 1,
    payload: () => ({}), beginResult: () => 1, status() {}, updateJobControls() {}, poll: async () => {},
    api: async (_path, _method, input) => { keys.push(input.idempotency_key); return { id: 'job' }; }
  });
  vm.runInContext(methods, context);
  for (let i = 0; i < 20; i++) { context.jobId = null; await context.startJob(); }
  expect(new Set(keys).size).toBe(20);
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
});
