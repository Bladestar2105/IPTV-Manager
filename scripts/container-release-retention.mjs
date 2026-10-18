import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function latestStableRelease(releases) {
    const stable = releases.filter(r => !r.draft && !r.prerelease
        && /^Stable-\d{2}\.\d{2}\.\d{2}(?:-hotfix\.\d+)?$/.test(r.tag));
    if (stable.some(r => !Number.isFinite(Date.parse(r.publishedAt)))) throw new Error('Missing stable publication date');
    stable.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    if (stable.length > 1 && Date.parse(stable[0].publishedAt) === Date.parse(stable[1].publishedAt)) {
        throw new Error('Ambiguous stable publication date');
    }
    return stable[0] || null;
}

// Pure planner: no deletion is possible until every release and dependency resolves.
export function planRetention(releases, versions) {
    if (!releases.length) throw new Error('No published releases');
    const byId = new Map(versions.map(v => [v.id, v]));
    if (byId.size !== versions.length || new Set(versions.map(v => v.digest)).size !== versions.length) {
        throw new Error('Duplicate package identities');
    }
    for (const v of versions) {
        for (const child of v.children) {
            if (!byId.has(child)) throw new Error('Missing manifest dependency');
        }
    }
    const visited = new Set();
    function checkGraph(id, path = new Set()) {
        if (path.has(id)) throw new Error('Cyclic manifest dependency');
        if (visited.has(id)) return;
        const next = new Set([...path, id]);
        byId.get(id).children.forEach(child => checkGraph(child, next));
        visited.add(id);
    }
    versions.forEach(v => checkGraph(v.id));
    const latest = versions.filter(v => v.tags.includes('latest'));
    if (latest.length !== 1) throw new Error('Expected exactly one latest image');
    const referenced = new Set(versions.flatMap(v => v.children));
    const roots = versions.filter(v => !referenced.has(v.id) || v.tags.length);
    const selected = releases.map(release => {
        const tagged = versions.filter(v => v.tags.includes(release.tag));
        if (tagged.some(v => v.revision !== release.commit) || tagged.length > 1) {
            throw new Error(`Release tag conflicts with commit: ${release.tag}`);
        }
        const candidates = roots.filter(v => v.revision === release.commit);
        const selected = tagged[0] || candidates.sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id - a.id)[0];
        if (!selected) throw new Error(`No image for published release: ${release.tag}`);
        return { ...release, id: selected.id, digest: selected.digest };
    });
    const retained = new Set();
    function keep(id) {
        if (retained.has(id)) return;
        retained.add(id);
        byId.get(id).children.forEach(keep);
    }
    selected.forEach(v => keep(v.id));
    keep(latest[0].id);
    const stable = latestStableRelease(selected);
    const stableLatest = stable ? { tag: 'Stable-Latest', id: stable.id, digest: stable.digest } : null;
    const tags = selected.filter(v => !byId.get(v.id).tags.includes(v.tag))
        .map(({ tag, id, digest }) => ({ tag, id, digest }));
    if (stableLatest && !byId.get(stableLatest.id).tags.includes(stableLatest.tag)) tags.push(stableLatest);
    return {
        releases: selected,
        latest: { id: latest[0].id, digest: latest[0].digest },
        stableLatest,
        retain: [...retained].sort((a, b) => a - b),
        remove: versions.filter(v => !retained.has(v.id)).map(v => v.id).sort((a, b) => a - b),
        tags
    };
}

const digestOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const imageTypes = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const indexTypes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const accept = [...imageTypes, ...indexTypes].join(', ');

async function metadataBytes(response) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('Manifest/config metadata exceeds safety limit');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN;
    const mode = process.env.RETENTION_MODE || 'dry-run';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token || !['dry-run', 'apply'].includes(mode)) {
        throw new Error('Repository, token and valid retention mode required');
    }
    const [owner, name] = repository.split('/');
    const image = repository.toLowerCase();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    async function api(path, method = 'GET') {
        const response = await fetch(`https://api.github.com${path}`, { method, headers });
        if (!response.ok) throw new Error(`GitHub API ${method} failed (${response.status})`);
        return response.status === 204 ? null : response.json();
    }
    async function pages(path) {
        const result = [];
        for (let page = 1; ; page++) {
            const batch = await api(`${path}?per_page=100&page=${page}`);
            if (!Array.isArray(batch)) throw new Error('Invalid paginated inventory');
            result.push(...batch);
            if (batch.length < 100) return result;
        }
    }
    const repo = await api(`/repos/${repository}`);
    const packagePath = `/${repo.owner.type === 'Organization' ? 'orgs' : 'users'}/${owner}/packages/container/${encodeURIComponent(name.toLowerCase())}`;
    async function releases() {
        const published = (await pages(`/repos/${repository}/releases`)).filter(r => !r.draft);
        const result = [];
        for (const release of published) {
            if (!/^(Stable-\d{2}\.\d{2}\.\d{2}(?:-hotfix\.\d+)?|v[\w.-]+)$/.test(release.tag_name)) {
                throw new Error('Unsupported published release tag');
            }
            let object = (await api(`/repos/${repository}/git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
            for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
                object = (await api(`/repos/${repository}/git/tags/${object.sha}`)).object;
            }
            if (object.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Unresolved release commit');
            result.push({ tag: release.tag_name, commit: object.sha,
                publishedAt: release.published_at, prerelease: release.prerelease });
        }
        return result.sort((a, b) => a.tag.localeCompare(b.tag));
    }
    const registryAuth = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull,push`, {
        headers: { Authorization: `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR}:${token}`).toString('base64')}` }
    });
    if (!registryAuth.ok) throw new Error(`Registry authentication failed (${registryAuth.status})`);
    const registryToken = (await registryAuth.json()).token;
    if (!registryToken) throw new Error('Missing registry token');
    async function registry(path, options = {}) {
        const response = await fetch(`https://ghcr.io/v2/${image}/${path}`, {
            ...options, headers: { Authorization: `Bearer ${registryToken}`, Accept: accept, ...options.headers }
        });
        if (!response.ok) throw new Error(`Registry request failed (${response.status})`);
        return response;
    }
    const manifests = new Map();
    async function manifest(digest) {
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid package digest');
        if (!manifests.has(digest)) {
            const response = await registry(`manifests/${digest}`);
            const bytes = await metadataBytes(response);
            if (digestOf(bytes) !== digest) throw new Error('Manifest digest mismatch');
            const data = JSON.parse(bytes);
            if (!imageTypes.has(data.mediaType) && !indexTypes.has(data.mediaType)) throw new Error('Unsupported manifest type');
            manifests.set(digest, { bytes, data });
        }
        return manifests.get(digest);
    }
    async function inventory() {
        const rows = await pages(`${packagePath}/versions`);
        return rows.map(v => {
            if (!Number.isSafeInteger(v.id) || !Array.isArray(v.metadata?.container?.tags) || !v.created_at) {
                throw new Error('Incomplete package inventory');
            }
            return { id: v.id, digest: v.name, tags: v.metadata.container.tags.sort(), createdAt: v.created_at };
        }).sort((a, b) => a.id - b.id);
    }
    const versions = await inventory();
    const ids = new Map(versions.map(v => [v.digest, v.id]));
    const revisions = new Map();
    async function inspect(digest, ancestors = new Set()) {
        if (ancestors.has(digest)) throw new Error('Cyclic manifest graph');
        if (revisions.has(digest)) return revisions.get(digest);
        const { data } = await manifest(digest);
        const next = new Set([...ancestors, digest]);
        let revision = null;
        if (indexTypes.has(data.mediaType)) {
            if (!Array.isArray(data.manifests) || !data.manifests.length) throw new Error('Empty manifest index');
            const children = [];
            let unknownImage = false;
            for (const child of data.manifests) {
                const childRevision = await inspect(child.digest, next);
                children.push(childRevision);
                const attestation = child.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
                    && child.platform?.os === 'unknown' && child.platform?.architecture === 'unknown';
                if (!childRevision && !attestation) unknownImage = true;
            }
            const known = [...new Set(children.filter(Boolean))];
            if (known.length > 1) throw new Error('Mixed image revisions in index');
            revision = unknownImage ? null : known[0] || null;
        } else {
            if (!/^sha256:[a-f0-9]{64}$/.test(data.config?.digest || '')) throw new Error('Missing image config');
            if (!['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json',
                'application/vnd.oci.empty.v1+json'].includes(data.config.mediaType)) throw new Error('Unsupported config type');
            const response = await registry(`blobs/${data.config.digest}`);
            const bytes = await metadataBytes(response);
            if (digestOf(bytes) !== data.config.digest) throw new Error('Config digest mismatch');
            const label = JSON.parse(bytes).config?.Labels?.['org.opencontainers.image.revision'];
            if (label !== undefined && !/^[a-f0-9]{40}$/.test(label)) throw new Error('Invalid image revision label');
            revision = label || null;
        }
        revisions.set(digest, revision);
        return revision;
    }
    for (const version of versions) {
        version.revision = await inspect(version.digest);
        const { data } = await manifest(version.digest);
        const dependencies = [...(data.manifests || [])];
        if (data.subject) dependencies.push(data.subject);
        version.children = dependencies.map(child => {
            if (!ids.has(child.digest)) throw new Error('Manifest dependency absent from package inventory');
            return ids.get(child.digest);
        });
    }
    const published = await releases();
    await writeFile('container-retention-inventory.json', JSON.stringify({ repository, inventory: versions, releases: published }, null, 2) + '\n');
    const plan = { repository, inventory: versions, ...planRetention(published, versions) };
    const json = JSON.stringify(plan, null, 2) + '\n';
    const hash = createHash('sha256').update(json).digest('hex');
    await writeFile('container-retention-plan.json', json);
    await writeFile('container-retention-plan.sha256', `${hash}\n`);
    console.log(JSON.stringify({ planSha256: hash, releases: published, retain: plan.retain.length, remove: plan.remove.length }));
    if (mode !== 'apply') return;
    if (!/^[a-f0-9]{64}$/.test(process.env.RETENTION_PLAN_SHA256 || '') || process.env.RETENTION_PLAN_SHA256 !== hash) {
        throw new Error('Reviewed plan SHA256 does not match; run and inspect a new dry-run');
    }
    // Recheck mutable registry state immediately before the first mutation.
    const expected = versions.map(({ id, digest, tags, createdAt }) => ({ id, digest, tags, createdAt }));
    if (JSON.stringify(await inventory()) !== JSON.stringify(expected) || JSON.stringify(await releases()) !== JSON.stringify(published)) {
        throw new Error('Inventory or releases changed; refusing mutation');
    }
    async function checkLatest() {
        const response = await registry('manifests/latest');
        if (digestOf(await metadataBytes(response)) !== plan.latest.digest) throw new Error('latest changed; stopping');
    }
    await checkLatest();
    for (const tag of plan.tags) {
        await checkLatest();
        const { bytes, data } = await manifest(tag.digest);
        await registry(`manifests/${encodeURIComponent(tag.tag)}`, {
            method: 'PUT', headers: { 'Content-Type': data.mediaType }, body: bytes
        });
        const response = await registry(`manifests/${encodeURIComponent(tag.tag)}`);
        if (digestOf(await metadataBytes(response)) !== tag.digest) throw new Error('Release tag verification failed');
    }
    // Delete parents before children, so no retained or not-yet-deleted index loses a child.
    const pending = new Set(plan.remove);
    while (pending.size) {
        const removable = [...pending].filter(id => !versions.some(v => pending.has(v.id) && v.children.includes(id)));
        if (!removable.length) throw new Error('Cyclic deletion graph');
        for (const id of removable) {
            await checkLatest();
            await api(`${packagePath}/versions/${id}`, 'DELETE');
            pending.delete(id);
        }
    }
    console.log(`Retained ${plan.retain.length}; deleted ${plan.remove.length} package versions.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
