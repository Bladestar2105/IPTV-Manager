import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Real-DB suites must never fall back to the application's runtime directory.
// An explicitly supplied DATA_DIR remains available for controlled fixtures.
const configuredDataDir = process.env.DATA_DIR;
const testDataDir = configuredDataDir || mkdtempSync(join(tmpdir(), 'iptv-manager-vitest-'));
if (!configuredDataDir) process.on('exit', () => rmSync(testDataDir, {recursive:true,force:true}));

export default defineConfig({test:{env:{DATA_DIR:testDataDir}}});
