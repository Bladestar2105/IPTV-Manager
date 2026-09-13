import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

describe('AI container security profiles', () => {
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
