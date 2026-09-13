import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

// Load deployment choices, but never import storage against deployment data.
dotenv.config({ quiet: true });

async function check() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--if-enabled')) throw Object.assign(new Error(), { code: 'AI_CODEX_PREFLIGHT_ARGUMENT' });
    if (args.includes('--if-enabled') && ['false', '0', 'no', 'off'].includes((process.env.AI_CODEX_ENABLED || '').toLowerCase())) {
        console.log('AI runtime preflight skipped: explicitly disabled.');
        return;
    }
    if (process.getuid?.() === 0) throw Object.assign(new Error(), { code: 'AI_CODEX_NON_ROOT_REQUIRED' });
    const directory = mkdtempSync(path.join(tmpdir(), 'iptv-ai-preflight-'));
    process.env.DATA_DIR = directory;
    process.env.AI_CODEX_RUNTIME_DIR = path.join(directory, 'runtime');
    process.env.AI_CODEX_ENABLED = 'true';
    let db, client;
    try {
        ({ default: db } = await import('../src/database/db.js'));
        const { codexAvailability, spawnDescription, handshake } = await import('../src/services/ai/codex/runtime.js');
        const { resolveIsolation } = await import('../src/services/ai/codex/isolation.js');
        const { createClient } = await import('../src/services/ai/codex/protocol.js');
        // Production availability runs the real sandbox canary and version probe.
        const availability = await codexAvailability({ force: true });
        if (!availability.available) throw Object.assign(new Error(), { code: availability.reason });
        const isolation = await resolveIsolation();
        const paths = { codexHome: path.join(process.env.AI_CODEX_RUNTIME_DIR, 'home'), workDir: path.join(process.env.AI_CODEX_RUNTIME_DIR, 'work') };
        for (const folder of [paths.codexHome, paths.workDir, path.join(paths.workDir, 'tmp')]) mkdirSync(folder, { recursive: true, mode: 0o700 });
        const description = spawnDescription(isolation, paths, availability.binary);
        let violation = false;
        client = createClient({ file: description.file, args: description.args, env: description.environment,
            onViolation: () => { violation = true; } });
        // Exactly the production strict flags and initialization; never sign in,
        // discover models, or submit a turn, and never hydrate a real identity.
        await handshake(client, paths, availability.version);
        if (violation || client.closed) throw Object.assign(new Error(), { code: 'AI_CODEX_RUNTIME_FAILED' });
        console.log(`AI runtime preflight passed: ${availability.backend} (${availability.grade}), Codex ${availability.version}, strict app-server handshake.`);
    } finally {
        if (client) { client.close(); await client.exited; }
        db?.close();
        rmSync(directory, { recursive: true, force: true });
    }
}

try { await check(); }
catch (error) {
    console.error(`AI runtime preflight failed: ${error.code || 'AI_CODEX_PREFLIGHT_FAILED'}`);
    process.exitCode = 1;
}
