import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/check-ai-runtime.mjs', import.meta.url));

it.each(['environment', 'dotenv'])('fails a missing runtime without touching deployment data (%s)', source => {
    const root = mkdtempSync(join(tmpdir(), 'iptv-preflight-test-'));
    const data = join(root, 'existing-data'), runtime = join(root, 'existing-runtime');
    for (const directory of [data, runtime]) mkdirSync(directory);
    writeFileSync(join(data, 'db.sqlite'), 'not a database: must never be opened');
    writeFileSync(join(runtime, 'auth.json'), 'existing credential sentinel');
    const configured = { DATA_DIR: data, AI_CODEX_RUNTIME_DIR: runtime, AI_CODEX_BIN: join(root, 'missing-codex'), AI_CODEX_ENABLED: 'false' };
    const env = { ...process.env, TMPDIR: root, ...configured };
    if (source === 'dotenv') {
        for (const key of Object.keys(configured)) delete env[key];
        writeFileSync(join(root, '.env'), Object.entries(configured).map(([key, value]) => `${key}=${value}`).join('\n'));
    }
    const before = readdirSync(root).sort();
    try {
        const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(process.getuid?.() === 0 ? 'AI_CODEX_NON_ROOT_REQUIRED' : 'AI_CODEX_BINARY_MISSING');
        expect(readFileSync(join(data, 'db.sqlite'), 'utf8')).toBe('not a database: must never be opened');
        expect(readFileSync(join(runtime, 'auth.json'), 'utf8')).toBe('existing credential sentinel');
        expect(readdirSync(root).sort()).toEqual(before);
        expect(readdirSync(data)).toEqual(['db.sqlite']);
        expect(readdirSync(runtime)).toEqual(['auth.json']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

it('lets installer checks skip an explicitly disabled adapter without creating runtime data', () => {
    const root = mkdtempSync(join(tmpdir(), 'iptv-preflight-disabled-'));
    try {
        const result = spawnSync(process.execPath, [script, '--if-enabled'], { cwd: root,
            env: { ...process.env, AI_CODEX_ENABLED: 'false', DATA_DIR: join(root, 'data'), AI_CODEX_RUNTIME_DIR: join(root, 'runtime'), TMPDIR: root },
            encoding: 'utf8', timeout: 30000 });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('skipped');
        expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
