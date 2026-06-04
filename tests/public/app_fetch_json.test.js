import { expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

test('fetchJSON surfaces API error fields in thrown messages', () => {
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public/app.js'), 'utf8');

  expect(appJs).toContain("errorData.message || errorData.error || 'HTTP ' + res.status");
});
