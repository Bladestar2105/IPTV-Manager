import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('AI container security profiles', () => {
    it.skipIf(spawnSync('docker', ['compose', 'version']).status !== 0)('keeps a copied Portainer stack self-contained and enables ChatGPT only with the sandbox override', () => {
        const directory = fs.mkdtempSync(path.join(tmpdir(), 'iptv-compose-test-'));
        try {
            const base = path.join(directory, 'compose.yml');
            fs.copyFileSync(new URL('../docker-compose.yml', import.meta.url), base);
            const config = files => {
                const result = spawnSync('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], {
                    encoding: 'utf8', env: { ...process.env, COMPOSE_PROJECT_NAME: 'iptv-profile-test', COMPOSE_ENV_FILES: '' }
                });
                expect(result.status, result.stderr).toBe(0);
                return JSON.parse(result.stdout).services['iptv-manager'];
            };
            const standard = config([base]);
            expect(standard.security_opt).toBeUndefined();
            expect(standard.privileged).not.toBe(true);
            expect(standard.cap_add).toBeUndefined();
            expect(standard.environment.AI_CODEX_ENABLED).toBe('false');
            const sandbox = config([base, new URL('../docker-compose.chatgpt.yml', import.meta.url).pathname]);
            expect(sandbox.security_opt).toEqual(['seccomp=./docker/ai-seccomp.json', 'apparmor=iptv-manager-ai']);
            expect(sandbox.environment.AI_CODEX_ENABLED).toBe('true');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    it.each([false,true])('tags only the verified image and stops after a failed push (%s)', failPush => {
        const workflow = fs.readFileSync(new URL('../.github/workflows/package.yml', import.meta.url), 'utf8');
        const step = workflow.split('- name: Push verified Docker image')[1].split('  release-package:')[0];
        const script = step.split('run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
        const result = spawnSync('/bin/bash', ['-e', '-c', `docker() {
          if [ "$1" = image ]; then echo sha256:verified; return; fi
          echo "$*"
          if [ "$1" = push ] && [ "$FAIL_PUSH" = 1 ]; then return 23; fi
          return 0
        }\n${script}`], { encoding:'utf8', env:{...process.env,IMAGE_TAGS:'registry.invalid/test:latest\n\nregistry.invalid/test:1.0',FAIL_PUSH:failPush?'1':'0'} });
        expect(result.status, result.stderr).toBe(failPush?23:0);
        const first=['tag sha256:verified registry.invalid/test:latest','push registry.invalid/test:latest'];
        expect(result.stdout.trim().split('\n')).toEqual(failPush?first:[...first,'tag sha256:verified registry.invalid/test:1.0','push registry.invalid/test:1.0']);
    });
    it('checks the integration PR and publishes the same image that was verified', () => {
        const workflow = fs.readFileSync(new URL('../.github/workflows/package.yml', import.meta.url), 'utf8');
        expect(workflow).toMatch(/pull_request:\s+branches:.*"codex\/ki-integration"/);
        expect(workflow.match(/uses: docker\/build-push-action/g)).toHaveLength(1);
        const publish = workflow.split('- name: Push verified Docker image')[1].split('  release-package:')[0];
        expect(publish).toContain("if: github.event_name != 'pull_request'");
        expect(publish).toContain('docker image inspect');
        expect(publish).toContain('iptv-manager:runtime-check');
        expect(publish).toContain('docker tag "$image_id" "$tag"');
        expect(publish).toContain('docker push "$tag"');
        expect(workflow).toMatch(/tags: iptv-manager:runtime-check\s+labels: \$\{\{ steps.meta.outputs.labels \}\}/);
    });
    it('documents persistent Docker profile loading and a non-root runtime check', () => {
        for (const path of ['../README.md','../docker/SECURITY-PROFILES.md']) {
            const doc = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
            expect(doc).toContain('install -o root -g root -m 0644 docker/ai-apparmor /etc/apparmor.d/iptv-manager-ai');
            expect(doc).toContain('apparmor_parser -r -W /etc/apparmor.d/iptv-manager-ai');
        }
        expect(fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8'))
            .toContain('docker compose exec -T --user app iptv-manager npm run check:ai-runtime');
    });
    it('retains default-deny seccomp and grants only the required nested namespace operations', () => {
        const profile = JSON.parse(fs.readFileSync(new URL('../docker/ai-seccomp.json', import.meta.url)));
        expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
        const extra = profile.syscalls.filter(rule => rule.comment?.startsWith('IPTV-Manager:'));
        expect(extra.flatMap(rule => rule.names).sort()).toEqual(['clone', 'mount', 'pivot_root', 'umount2', 'unshare']);
        expect(extra.find(rule => rule.names.includes('clone')).args).toEqual([
            { index: 0, value: 2114060288, valueTwo: 1040318464, op: 'SCMP_CMP_MASKED_EQ' }
        ]);
        expect(extra.find(rule => rule.names.includes('unshare')).args).toEqual([
            { index: 0, value: 268435456, op: 'SCMP_CMP_EQ' }
        ]);
        expect(profile.syscalls.some(rule => rule.names.includes('clone3') && rule.errnoRet === 38)).toBe(true);
        const baseline = { ...profile, syscalls: profile.syscalls.filter(rule => !extra.includes(rule)) };
        // Canonical JSON of the pinned upstream profile: no unrelated syscall relaxations.
        expect(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'))
            .toBe('afb4934b023cfceaaec1a9d752ca3f801aaa96eb2e59abe6e7ea16976948e080');
    });

    it('keeps an enforced, named AppArmor profile and Docker sensitive-path denials', () => {
        const profile = fs.readFileSync(new URL('../docker/ai-apparmor', import.meta.url), 'utf8');
        expect(profile).toContain('profile iptv-manager-ai flags=(attach_disconnected,mediate_deleted)');
        expect(profile).not.toMatch(/flags=.*(?:unconfined|complain)/);
        expect(profile).toContain('deny /sys/kernel/security/** rwklx,');
        expect(profile).toContain('deny @{PROC}/sysrq-trigger rwklx,');
        expect(profile).toContain('pivot_root,');
        expect(profile).not.toMatch(/^\s*mount,\s*$/m);
        expect(profile).not.toContain('fstype=proc');
    });

    it('attaches the native enforced profile only to the private sandbox executable', () => {
        const profile = fs.readFileSync(new URL('../scripts/ai-bwrap.apparmor', import.meta.url), 'utf8');
        expect(profile).toContain('profile iptv-manager-bwrap /usr/local/lib/iptv-manager/bwrap flags=(attach_disconnected,mediate_deleted)');
        expect(profile).toContain('abi <abi/3.0>,');
        expect(profile).not.toMatch(/flags=.*(?:unconfined|complain)/);
        expect(profile).not.toContain('fstype=proc');
        expect(profile).toContain('deny /sys/kernel/security/** rwklx,');
    });
});
