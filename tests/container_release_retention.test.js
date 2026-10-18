import { describe, expect, it } from 'vitest';
import { latestStableRelease, planRetention } from '../scripts/container-release-retention.mjs';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const version = (id, revision, children = [], tags = []) => ({
    id, digest: `sha256:${String(id).padStart(64, '0')}`, revision, children,
    tags, createdAt: `2026-10-${String(id).padStart(2, '0')}T00:00:00Z`
});
const release = { tag: 'Stable-26.10.18', commit: sha, publishedAt: '2026-10-18T10:00:00Z', prerelease: false };

describe('container release retention', () => {
    it('keeps release roots, latest, and recursive platform/attestation dependencies', () => {
        const versions = [version(1, sha, [2, 3]), version(2, sha),
            version(3, null, [4]), version(4, null), version(5, other, [], ['latest']),
            version(6, other), version(7, null)];
        expect(planRetention([release], versions)).toEqual({
            releases: [{ ...release, id: 1, digest: versions[0].digest }],
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
