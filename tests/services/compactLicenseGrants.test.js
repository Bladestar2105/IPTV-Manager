import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { playreadyMp4, providerLicense } from '../fixtures/playreadyMp4.js';

const { getXtreamUser, fetchSafe } = vi.hoisted(() => ({ getXtreamUser: vi.fn(), fetchSafe: vi.fn() }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
vi.mock('../../src/services/logoResolver.js', () => ({ getEpgLogo: vi.fn(), registerProviderCachedIcon: vi.fn(), getLogoCacheHash: vi.fn() }));
vi.mock('../../src/utils/network.js', async importOriginal => ({ ...await importOriginal(), fetchSafe }));

import db, { initDb, DB_PATH } from '../../src/database/db.js';
import path from 'node:path';
import { createClientResourceUrl, resolveClientResource, resolveCompactLicenseResource } from '../../src/services/clientResourceService.js';
import resourceRouter, { shortLicenseRouter } from '../../src/routes/proxy.js';
import { upstreamRequestHeaders } from '../../src/utils/clientCookies.js';

const user = { id: 919191, token_version: 0, is_active: 1 };
const req = () => ({ protocol: 'https', get: name => name === 'host' ? 'manager.test' : undefined, app: { get: () => false }, query: {}, params: {}, ip: '203.0.113.1' });
const issue = (options = {}, source = req()) => createClientResourceUrl(source, user, 'https://provider.test/license?secret=private', { kind: 'license', compact: true, headers: { Authorization: 'Bearer upstream-secret', Cookie: 'session=private' }, ...options });
const resolve = url => resolveCompactLicenseResource({ ...req(), params: { id: new URL(url).pathname.split('/').pop() } });
beforeAll(() => { initDb(true); });
beforeEach(() => {
  vi.useRealTimers();
  db.prepare('DELETE FROM client_license_grants').run();
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  db.prepare('INSERT INTO users (id, username, password, is_active) VALUES (?, ?, ?, 1)').run(user.id, 'compact-test', 'unused');
  getXtreamUser.mockResolvedValue(user);
  fetchSafe.mockReset();
});
afterAll(() => { vi.useRealTimers(); db.prepare('DELETE FROM users WHERE id = ?').run(user.id); });

it('persists opaque encrypted grants, deduplicates repeat PSSH, and survives fresh module instances', async () => {
  const url = issue();
  expect(url).toMatch(/^https:\/\/manager\.test\/r\/[A-Za-z0-9_-]{22}$/);
  const writes = db.prepare('SELECT total_changes() AS count').get().count;
  for (let i = 0; i < 100; i++) expect(issue()).toBe(url);
  expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(writes);
  const rows = db.prepare('SELECT * FROM client_license_grants').all();
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/provider\.test|upstream-secret|session=private/);
  vi.resetModules();
  const fresh = await import('../../src/services/clientResourceService.js');
  const resource = await fresh.resolveCompactLicenseResource({ ...req(), params: { id: new URL(url).pathname.split('/').pop() } });
  expect(resource).toMatchObject({ kind: 'license', url: 'https://provider.test/license?secret=private' });
  expect(new Headers(upstreamRequestHeaders(resource, resource.url)).get('cookie')).toBe('session=private');
  const script = `import { resolveCompactLicenseResource } from './src/services/clientResourceService.js';
    const resource = await resolveCompactLicenseResource({ params: { id: ${JSON.stringify(new URL(url).pathname.split('/').pop())} }, ip: '203.0.113.1', headers: {} });
    console.log(JSON.stringify({ kind: resource?.kind, url: resource?.url }));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DATA_DIR: path.dirname(DB_PATH) } });
  expect(JSON.parse(output.trim().split('\n').pop())).toEqual({ kind: 'license', url: 'https://provider.test/license?secret=private' });
}, 20000);

it('expires after seven days, renews during issuance, and rechecks user revocation', async () => {
  const url = issue();
  const start = Date.now();
  vi.useFakeTimers(); vi.setSystemTime(start + 2 * 86400000);
  expect(issue()).toBe(url);
  vi.setSystemTime(start + 8 * 86400000);
  expect(await resolve(url)).not.toBeNull();
  vi.setSystemTime(start + 10 * 86400000);
  expect(await resolve(url)).toBeNull();
  vi.useRealTimers();
  const renewed = issue();
  db.prepare('UPDATE users SET token_version = 1 WHERE id = ?').run(user.id);
  expect(await resolve(renewed)).toBeNull();
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  expect(await resolve(renewed)).toBeNull();
});

it('rechecks channel and source-token/share access', async () => {
  expect(await resolve(issue({ channelId: 999999 }))).toBeNull();
  const source = req(); source.query.token = 'share-token';
  const url = issue({}, source);
  getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, share_end: 1 });
  expect(await resolve(url)).toBeNull();
  getXtreamUser.mockResolvedValue(null);
  expect(await resolve(url)).toBeNull();
});

it('revokes every provider-only grant after ownership transfer or deletion while retaining admin access',async()=>{
  const other=user.id+1;
  db.prepare('INSERT INTO users(id,username,password,is_active) VALUES(?,?,?,1)').run(other,'compact-other','unused');
  db.prepare('INSERT INTO admin_users(id,username,password,is_active) VALUES(?,?,?,1)').run(user.id,'compact-admin','unused');
  db.prepare('INSERT INTO providers(id,name,url,username,password,user_id) VALUES(?,?,?,?,?,?)').run(user.id,'compact','https://provider.test','u','p',user.id);
  try{
    const create=owner=>[['image',false],['resource',false],['license',false],['license',true]].map(([kind,compact])=>
      createClientResourceUrl(req(),owner,'https://provider.test/private',{kind,compact,providerId:user.id}));
    const check=url=>new URL(url).pathname.startsWith('/r/')?resolve(url):resolveClientResource({...req(),params:{data:new URL(url).pathname.split('/')[4]}});
    const normal=create(user),admin=create({...user,is_admin:true});
    for(const url of [...normal,...admin]) expect(await check(url)).not.toBeNull();
    db.prepare('UPDATE providers SET user_id=? WHERE id=?').run(other,user.id);
    for(const url of normal) expect(await check(url)).toBeNull();
    for(const url of admin) expect(await check(url)).not.toBeNull();
    db.prepare('DELETE FROM providers WHERE id=?').run(user.id);
    for(const url of [...normal,...admin]) expect(await check(url)).toBeNull();
  }finally{
    db.prepare('DELETE FROM providers WHERE id=?').run(user.id);
    db.prepare('DELETE FROM admin_users WHERE id=?').run(user.id);
    db.prepare('DELETE FROM users WHERE id=?').run(other);
  }
});

it('rechecks a previously authorized channel after it is hidden and a share after its scope changes', async () => {
  db.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, 'compact', 'https://provider.test', 'u', 'p', user.id);
  db.prepare('INSERT INTO provider_channels (id, provider_id, remote_stream_id, name) VALUES (?, ?, ?, ?)').run(user.id, user.id, 1, 'compact');
  db.prepare('INSERT INTO user_categories (id, user_id, name) VALUES (?, ?, ?)').run(user.id, user.id, 'compact');
  db.prepare("INSERT INTO user_channels (id, user_category_id, provider_channel_id, assignment_origin) VALUES (?, ?, ?, 'manual')").run(user.id, user.id, user.id);
  try {
    const source = req(); source.query.token = 'share-token';
    const url = issue({ channelId: user.id }, source);
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [user.id] });
    expect(await resolve(url)).not.toBeNull();
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [] });
    expect(await resolve(url)).toBeNull();
    getXtreamUser.mockResolvedValue(user);
    db.prepare('UPDATE user_channels SET is_hidden = 1 WHERE id = ?').run(user.id);
    expect(await resolve(url)).toBeNull();
  } finally {
    for (const table of ['user_channels', 'user_categories', 'provider_channels', 'providers']) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(user.id);
  }
});

it('keeps range rewrite IDs stable as credentials rotate within a scoped media entity', async () => {
  db.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, 'compact', 'https://provider.test', 'u', 'p', user.id);
  db.prepare('INSERT INTO provider_channels (id, provider_id, remote_stream_id, name) VALUES (?, ?, ?, ?)').run(user.id, user.id, 1, 'compact');
  db.prepare('INSERT INTO user_categories (id, user_id, name) VALUES (?, ?, ?)').run(user.id, user.id, 'compact');
  db.prepare("INSERT INTO user_channels (id, user_category_id, provider_channel_id, assignment_origin) VALUES (?, ?, ?, 'manual')").run(user.id, user.id, user.id);
  try {
    const scope = { providerId: user.id, channelId: user.id, compactIdentity: 'entity.mp4:strong-validator' };
    const first = issue(scope);
    const rotated = { ...scope, headers: { Authorization: 'Bearer rotated', Cookie: 'session=rotated' } };
    expect(issue(rotated)).toBe(first);
    const current = await resolve(first);
    const headers = new Headers(upstreamRequestHeaders(current, current.url));
    expect(headers.get('authorization')).toBe('Bearer rotated');
    expect(headers.get('cookie')).toBe('session=rotated');
    const writes = db.prepare('SELECT total_changes() AS count').get().count;
    for (let i = 0; i < 10; i++) expect(issue(rotated)).toBe(first);
    expect(db.prepare('SELECT total_changes() AS count').get().count).toBe(writes);
    expect(issue({ ...rotated, compactIdentity: 'different-entity' })).not.toBe(first);
    expect(issue({ ...rotated, providerId: user.id + 1 })).not.toBe(first);
    expect(issue({ ...rotated, channelId: user.id + 1 })).not.toBe(first);
    const share = req(); share.query.token = 'another-share';
    expect(issue(rotated, share)).not.toBe(first);
    const pooledId=user.id+1;
    db.prepare('INSERT INTO providers (id,name,url,username,password,user_id) VALUES (?,?,?,?,?,?)').run(pooledId,'pooled','https://provider.test','second','private',user.id);
    try {
      const compact=issue({...scope,providerId:pooledId});
      const generic=createClientResourceUrl(req(),user,'https://provider.test/license',{kind:'license',channelId:user.id,providerId:pooledId});
      const resolveGeneric=()=>resolveClientResource({...req(),params:{data:new URL(generic).pathname.split('/')[4]}});
      const linked=['image','resource'].map(kind=>createClientResourceUrl(req(),user,'https://provider.test/private',{kind,channelId:user.id,providerId:pooledId}));
      const resolveLinked=url=>resolveClientResource({...req(),params:{data:new URL(url).pathname.split('/')[4]}});
      expect(await resolve(compact)).not.toBeNull(); expect(await resolveGeneric()).not.toBeNull();
      for(const url of linked) expect(await resolveLinked(url)).not.toBeNull();
      db.prepare('DELETE FROM providers WHERE id=?').run(pooledId);
      expect(await resolve(compact)).toBeNull(); expect(await resolveGeneric()).toBeNull();
      for(const url of linked) expect(await resolveLinked(url)).toBeNull();
    } finally { db.prepare('DELETE FROM providers WHERE id=?').run(pooledId); }
    db.prepare('UPDATE users SET token_version = 1 WHERE id = ?').run(user.id);
    expect(await resolve(first)).toBeNull();
  } finally {
    for (const table of ['user_channels', 'user_categories', 'provider_channels', 'providers']) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(user.id);
  }
});

it('keeps generic compact grants isolated by credential context', () => {
  const first = issue();
  expect(issue({ headers: { Authorization: 'Bearer other' } })).not.toBe(first);
  const identity = { compactIdentity: 'same-entity' };
  expect(issue(identity)).not.toBe(issue({ ...identity, headers: { Authorization: 'Bearer other' } }));
});

it('bounds indexed expiry cleanup and rejects a stored non-license grant', async () => {
  const url = issue();
  const row = db.prepare('SELECT * FROM client_license_grants').get();
  for (let i = 0; i < 150; i++) db.prepare('INSERT INTO client_license_grants VALUES (?, ?, ?, ?)').run(`expired-${i}`, `expired-${i}`, row.envelope, 1);
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120000);
  vi.resetModules();
  const fresh = await import('../../src/services/clientResourceService.js');
  fresh.createClientResourceUrl(req(), user, 'https://provider.test/new-license', { kind: 'license', compact: true });
  expect(db.prepare('SELECT count(*) AS count FROM client_license_grants WHERE expires_at = 1').get().count).toBe(50);
  const image = createClientResourceUrl(req(), user, 'https://provider.test/a.png');
  db.prepare('UPDATE client_license_grants SET envelope = ? WHERE id = ?').run(new URL(image).pathname.split('/')[4], new URL(url).pathname.split('/').pop());
  expect(await resolve(url)).toBeNull();
});

it('relays exact binary POST bytes, SOAPAction and grant headers; rejects supplied URLs and bearer IDs', async () => {
  const app = express(); app.use('/r', express.raw({ type: () => true, limit: '1mb' }), shortLicenseRouter);
  const body = Buffer.from([0, 255, 123, 13, 10, 0]);
  fetchSafe.mockResolvedValue({ ok: true, status: 200, url: 'https://provider.test/license', headers: new Headers({ 'content-type': 'application/octet-stream' }), body: null,
    arrayBuffer: async () => Buffer.from('license-response') });
  const response = await request(app).post(new URL(issue()).pathname).set('Content-Type', 'application/octet-stream').set('SOAPAction', 'license-action').send(body);
  expect(response.status).toBe(200);
  expect(fetchSafe).toHaveBeenCalledWith('https://provider.test/license?secret=private', expect.objectContaining({ method: 'POST', body, headers: expect.objectContaining({ Authorization: 'Bearer upstream-secret', soapaction: 'license-action' }) }));
  fetchSafe.mockClear();
  expect((await request(app).post('/r/not-a-grant?url=https://evil.test').set('Authorization', 'Bearer token').send(body)).status).toBe(401);
  expect(fetchSafe).not.toHaveBeenCalled();
});

it('rewrites a real MP4 through a grant and relays the resulting compact license challenge', async () => {
  db.prepare('INSERT INTO providers (id, name, url, username, password, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, 'compact', 'https://provider.example', 'u', 'p', user.id);
  db.prepare('INSERT INTO provider_channels (id, provider_id, remote_stream_id, name) VALUES (?, ?, ?, ?)').run(user.id, user.id, 1, 'compact');
  db.prepare('INSERT INTO user_categories (id, user_id, name) VALUES (?, ?, ?)').run(user.id, user.id, 'compact');
  db.prepare("INSERT INTO user_channels (id, user_category_id, provider_channel_id, assignment_origin) VALUES (?, ?, ?, 'manual')").run(user.id, user.id, user.id);
  try {
    const original = playreadyMp4();
    const app = express(); app.use(express.raw({ type: () => true, limit: '1mb' }));
    app.use('/api/proxy', resourceRouter); app.use('/r', shortLicenseRouter);
    fetchSafe.mockImplementation(async url => ({ ok: true, status: 200, url,
      headers: new Headers({ 'content-type': url === providerLicense ? 'application/octet-stream' : 'video/mp4', 'content-length': String(url === providerLicense ? 7 : original.length), 'set-cookie': 'session=rotated; Path=/' }),
      body: Readable.from([url === providerLicense ? Buffer.from('license') : original]) }));
    const resource = createClientResourceUrl(req(), user, 'https://provider.example/init.mp4', { kind: 'resource', providerId: user.id, channelId: user.id, headers: { Authorization: 'Bearer upstream-secret', Cookie: 'session=private' } });
    const media = await request(app).get(new URL(resource).pathname).set('Host','manager.test');
    expect(media.status).toBe(200);
    expect(media.body.length).toBe(original.length);
    const license = media.body.toString('utf16le').match(/<LA_URL>([^<]+)<\/LA_URL>/)?.[1];
    expect(license).toMatch(/^http:\/\/manager\.test\/r\/[\w-]{22}$/);
    expect(media.body.includes(Buffer.from(providerLicense, 'utf16le'))).toBe(false);
    const challenge = Buffer.from([0, 255, 13, 10]);
    expect((await request(app).post(new URL(license).pathname).set('Content-Type', 'application/octet-stream').set('SOAPAction', 'playready-action').send(challenge)).body).toEqual(Buffer.from('license'));
    expect(fetchSafe).toHaveBeenLastCalledWith(providerLicense, expect.objectContaining({ method: 'POST', body: challenge,
      headers: expect.objectContaining({ Authorization: 'Bearer upstream-secret', Cookie: 'session=rotated', soapaction: 'playready-action' }) }));
    // A second playback must not replace the first CDM session's cookie envelope.
    fetchSafe.mockImplementation(async url => ({ok:true,status:200,url,
      headers:new Headers({'content-type':url===providerLicense?'application/octet-stream':'video/mp4','content-length':String(url===providerLicense?7:original.length),
        ...(url!==providerLicense?{'set-cookie':'session=second; Path=/'}:{})}),
      body:Readable.from([url===providerLicense?Buffer.from('license'):original])}));
    const secondResource=createClientResourceUrl(req(),user,'https://provider.example/init.mp4',{kind:'resource',providerId:user.id,channelId:user.id,headers:{Authorization:'Bearer upstream-secret',Cookie:'session=second'}});
    const secondMedia=await request(app).get(new URL(secondResource).pathname).set('Host','manager.test');
    const secondLicense=secondMedia.body.toString('utf16le').match(/<LA_URL>([^<]+)<\/LA_URL>/)?.[1];
    expect(new URL(secondLicense).pathname).not.toBe(new URL(license).pathname);
    await request(app).post(new URL(license).pathname).set('Content-Type','application/octet-stream').send(challenge);
    expect(fetchSafe).toHaveBeenLastCalledWith(providerLicense,expect.objectContaining({headers:expect.objectContaining({Cookie:'session=rotated'})}));
    const samePlayback=await request(app).get(new URL(resource).pathname).set('Host','manager.test');
    expect(samePlayback.body.toString('utf16le').match(/<LA_URL>([^<]+)<\/LA_URL>/)?.[1]).toBe(license);
  } finally {
    for (const table of ['user_channels', 'user_categories', 'provider_channels', 'providers']) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(user.id);
  }
});
