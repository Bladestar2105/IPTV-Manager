import { describe, expect, it } from 'vitest';
import { isStableReleaseTag, latestStableRelease, planRetention, validateReleaseRef } from '../scripts/container-release-retention.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const version = (id, revision, children = [], tags = []) => ({
    id, digest: `sha256:${String(id).padStart(64, '0')}`, revision, children,
    tags, createdAt: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`
});
const release = { tag: 'Stable-26.10.18', commit: sha, publishedAt: '2026-10-18T10:00:00Z', prerelease: false };

describe('container release retention', () => {
    it.each(['Stable-26.13.40', 'Stable-26.02.30', 'Stable-26.02.29', 'Stable-26.00.18',
        'Stable-26.10.00', 'Stable-26.04.31', 'Stable-99.02.29', 'Stable-00.02.30'])(
        'rejects impossible calendar date %s at every release boundary', tag => {
            expect(isStableReleaseTag(tag)).toBe(false);
            expect(() => validateReleaseRef(`refs/tags/${tag}`)).toThrow(/Stable/);
            expect(latestStableRelease([{ tag, publishedAt: '2026-10-18T10:00:00Z' }])).toBeNull();
        });
    it('rejects a final newline instead of accepting a partial regex match', () => {
        expect(isStableReleaseTag('Stable-26.10.18\n')).toBe(false);
    });
    it.each(['Stable-28.02.29', 'Stable-00.02.29', 'Stable-26.12.31'])(
        'accepts real calendar date %s including leap years', tag => {
            expect(isStableReleaseTag(tag)).toBe(true);
            expect(() => validateReleaseRef(`refs/tags/${tag}`)).not.toThrow();
        });
    it('accepts a 128-character Docker tag and rejects 129 characters', () => {
        const prefix = 'Stable-26.10.18-hotfix.';
        const accepted = prefix + '1'.repeat(128 - prefix.length);
        const rejected = accepted + '1';
        expect(isStableReleaseTag(accepted)).toBe(true);
        expect(() => validateReleaseRef(`refs/tags/${accepted}`)).not.toThrow();
        expect(isStableReleaseTag(rejected)).toBe(false);
        expect(() => validateReleaseRef(`refs/tags/${rejected}`)).toThrow(/Stable/);
    });
    it.each(['refs/tags/Stable-26.10.18', 'refs/tags/Stable-26.10.18-hotfix.2',
        'refs/heads/main', 'refs/pull/10/merge', 'refs/tags/v1.2.3'])(
        'allows supported release and non-release ref %s', ref => {
            expect(() => validateReleaseRef(ref)).not.toThrow();
        });
    it.each(['refs/tags/Stable-test', 'refs/tags/Stable-Latest', 'refs/tags/Stable-26.10.18-extra',
        'refs/tags/Stable-26.10.18-hotfix.2-extra'])(
        'blocks malformed Stable release ref %s before publication', ref => {
            expect(() => validateReleaseRef(ref)).toThrow(/Stable/);
        });
    it('keeps release roots, latest, and recursive platform/attestation dependencies', () => {
        const versions = [version(1, sha, [2, 3]), version(2, sha),
            version(3, null, [4]), version(4, null), version(5, other, [], ['latest']),
            version(6, other), version(7, null)];
        expect(planRetention([release], versions)).toEqual({
            releases: [{ ...release, id: 1, digest: versions[0].digest }],
            missingReleases: [],
            latest: { id: 5, digest: versions[4].digest },
            stableLatest: { tag: 'Stable-Latest', id: 1, digest: versions[0].digest },
            retain: [1, 2, 3, 4, 5], remove: [6, 7],
            tags: [{ tag: release.tag, id: 1, digest: versions[0].digest },
                { tag: 'Stable-Latest', id: 1, digest: versions[0].digest }]
        });
    });
    it('chooses an already tagged root before a newer duplicate build', () => {
        const versions = [version(1, sha, [], [release.tag]), version(2, sha),
            version(3, other, [], ['latest'])];
        expect(planRetention([release], versions).remove).toEqual([2]);
    });
    it('chooses the newest duplicate root when neither is release-tagged', () => {
        const versions = [version(1, sha), version(2, sha), version(3, other, [], ['latest'])];
        expect(planRetention([release], versions).releases[0].id).toBe(2);
    });
    it('refuses to delete anything when a published release has no image revision match', () => {
        expect(() => planRetention([release], [version(1, other, [], ['latest'])])).toThrow(/No image/);
    });
    it('reports an explicitly allowed missing historical release without inventing an image', () => {
        const historical = { ...release, tag: 'Stable-26.01.29', commit: other, publishedAt: '2026-01-29T10:00:00Z' };
        const versions = [version(1, sha, [], ['latest'])];
        const plan = planRetention([historical, release], versions, [historical.tag]);
        expect(plan.missingReleases).toEqual([{ tag: historical.tag, commit: other }]);
        expect(plan.releases).toEqual([{ ...release, id: 1, digest: versions[0].digest }]);
        expect(plan.stableLatest).toEqual({ tag: 'Stable-Latest', id: 1, digest: versions[0].digest });
    });
    it('rejects unknown, duplicate, malformed, and no-longer-missing allowances', () => {
        const versions = [version(1, sha, [], ['latest'])];
        expect(() => planRetention([release], versions, ['Stable-26.01.29'])).toThrow(/Unknown/);
        expect(() => planRetention([release], versions, [release.tag, release.tag])).toThrow(/Duplicate/);
        expect(() => planRetention([release], versions, release.tag)).toThrow(/array/);
        expect(() => planRetention([release], versions, [null])).toThrow(/Unknown/);
        expect(() => planRetention([release], versions, [release.tag])).toThrow(/exists/);
    });
    it('never permits an allowance to hide a missing latest stable image', () => {
        const historical = { ...release, tag: 'Stable-26.01.29', commit: other, publishedAt: '2026-01-29T10:00:00Z' };
        expect(() => planRetention([historical, release], [version(1, other, [], ['latest'])], [release.tag]))
            .toThrow(/latest stable/);
    });
    it('never permits an allowance to hide a conflicting existing release tag', () => {
        const historical = { ...release, tag: 'Stable-26.01.29', commit: other, publishedAt: '2026-01-29T10:00:00Z' };
        expect(() => planRetention([historical, release], [version(1, sha, [], ['latest', historical.tag])], [historical.tag]))
            .toThrow(/conflicts/);
    });
    it('refuses a release tag pointing at the wrong commit', () => {
        expect(() => planRetention([release], [version(1, sha), version(2, other, [], [release.tag, 'latest'])])).toThrow(/conflicts/);
    });
    it('refuses incomplete dependency graphs and absent latest', () => {
        expect(() => planRetention([release], [version(1, sha, [99], ['latest'])])).toThrow(/dependency/);
        expect(() => planRetention([release], [version(1, sha)])).toThrow(/latest/);
    });
    it('refuses cyclic dependencies before proposing any mutation', () => {
        expect(() => planRetention([release], [version(1, sha, [2], ['latest']), version(2, null, [1])])).toThrow(/Cyclic/);
    });
    it('refuses empty releases, duplicate identities, and ambiguous latest', () => {
        expect(() => planRetention([], [version(1, sha, [], ['latest'])])).toThrow(/releases/);
        expect(() => planRetention([release], [version(1, sha, [], ['latest']), version(1, sha)])).toThrow(/Duplicate/);
        expect(() => planRetention([release], [version(1, sha, [], ['latest']), version(2, sha, [], ['latest'])])).toThrow(/latest/);
    });
    it('moves Stable-Latest from an older root to the most recently published stable, excluding prereleases', () => {
        const newer = { ...release, tag: 'Stable-26.10.18-hotfix.2', commit: other, publishedAt: '2026-10-18T12:00:00Z' };
        const preview = { ...release, tag: 'Stable-26.10.18-hotfix.99', prerelease: true, publishedAt: '2026-10-18T14:00:00Z' };
        const versions = [version(1, sha, [], [release.tag, 'Stable-Latest']),
            version(2, other, [3], [newer.tag]), version(3, other), version(4, null, [], ['latest'])];
        const plan = planRetention([release, preview, newer], versions);
        expect(plan.stableLatest).toEqual({ tag: 'Stable-Latest', id: 2, digest: versions[1].digest });
        expect(plan.tags).toContainEqual({ tag: 'Stable-Latest', id: 2, digest: versions[1].digest });
        expect(plan.retain).toEqual([1, 2, 3, 4]);
    });
    it('selects by publication time even when an older lexical hotfix tag is rerun', () => {
        const old = { ...release, tag: 'Stable-26.10.18-hotfix.9' };
        const newest = { ...release, tag: 'Stable-26.10.18-hotfix.10', publishedAt: '2026-10-18T12:00:00Z' };
        expect(latestStableRelease([newest, old])).toEqual(newest);
        expect(latestStableRelease([old, newest])).toEqual(newest);
    });
});
