import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const { getXtreamUser } = vi.hoisted(() => ({ getXtreamUser: vi.fn() }));
vi.mock('../../src/services/authService.js', () => ({ getXtreamUser }));
vi.mock('../../src/services/geoIpService.js', () => ({ isIpAllowedForUser: () => true }));
import db, { initDb } from '../../src/database/db.js';
import epgDb, { initEpgDb } from '../../src/database/epgDb.js';
import * as resources from '../../src/services/clientResourceService.js';
import { decryptClientGrant } from '../helpers/clientResourceGrant.js';

const user = { id: 737373, is_active: 1, token_version: 0 };
const req = () => ({ protocol: 'https', get: () => 'manager.test', app: { get: () => false }, query: {}, params: {}, headers: {} });
const channel = { id: 'shared.epg', source_type: 'provider', source_id: 737373 };
const issue = (row = channel, options = {}, request = req()) => resources.createEpgIconUrl(request, user, row, options);
const resolve = url => resources.resolveClientResource({ ...req(), params: { data: new URL(url).pathname.split('/')[4] } });

beforeAll(() => { initDb(true); initEpgDb(); });
const cleanup = () => {
  for (const table of ['user_channels', 'user_categories', 'provider_channels', 'providers', 'users']) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(user.id);
  db.prepare('DELETE FROM epg_sources WHERE id = ?').run(user.id);
  epgDb.prepare('DELETE FROM epg_channels WHERE source_id = ?').run(user.id);
};
afterAll(cleanup);
beforeEach(() => {
  cleanup();
  db.prepare('INSERT INTO users(id,username,password,is_active) VALUES(?,?,?,1)').run(user.id, 'epg-grant', 'unused');
  db.prepare('INSERT INTO providers(id,name,url,username,password) VALUES(?,?,?,?,?)').run(user.id, 'shared', 'https://provider.test/feed/guide.xml', 'u', 'p');
  epgDb.prepare('INSERT INTO epg_channels(id,name,logo,source_type,source_id) VALUES(?,?,?,?,?)').run(channel.id, 'Shared', 'old.png', channel.source_type, channel.source_id);
  getXtreamUser.mockResolvedValue(user);
});

describe('current EPG artwork grants', () => {
  it('keeps global catalog artwork available while following exact-source logo changes and deletion', async () => {
    const url = issue();
    expect(await decryptClientGrant(url)).toMatchObject({ epgChannelId: channel.id, epgSourceType: 'provider', epgSourceId: user.id });
    expect(await decryptClientGrant(url)).not.toHaveProperty('url');
    expect(await resolve(url)).toMatchObject({ url: 'https://provider.test/feed/old.png' });
    epgDb.prepare('UPDATE epg_channels SET logo = ? WHERE source_id = ?').run('new.png', user.id);
    expect(await resolve(url)).toMatchObject({ url: 'https://provider.test/feed/new.png' });
    epgDb.prepare('DELETE FROM epg_channels WHERE source_id = ?').run(user.id);
    expect(await resolve(url)).toBeNull();
  });
  it.each(['provider', 'custom'])('revokes %s source grants when the source disappears even if its EPG row remains', async type => {
    if (type === 'custom') {
      db.prepare('INSERT INTO epg_sources(id,name,url) VALUES(?,?,?)').run(user.id, 'shared custom', 'https://custom.test/guide.xml');
      epgDb.prepare('UPDATE epg_channels SET source_type = ? WHERE source_id = ?').run(type, user.id);
    }
    const url = issue({ ...channel, source_type: type });
    expect(await resolve(url)).not.toBeNull();
    db.prepare(`DELETE FROM ${type === 'provider' ? 'providers' : 'epg_sources'} WHERE id = ?`).run(user.id);
    expect(await resolve(url)).toBeNull();
  });
  it('rechecks XMLTV mappings and current share channel scope', async () => {
    db.prepare('UPDATE providers SET user_id = ? WHERE id = ?').run(user.id, user.id);
    db.prepare('INSERT INTO provider_channels(id,provider_id,remote_stream_id,name,epg_channel_id) VALUES(?,?,?,?,?)').run(user.id, user.id, '1', 'News', channel.id);
    db.prepare('INSERT INTO user_categories(id,user_id,name) VALUES(?,?,?)').run(user.id, user.id, 'Live');
    db.prepare('INSERT INTO user_channels(id,user_category_id,provider_channel_id) VALUES(?,?,?)').run(user.id, user.id, user.id);
    const source = req(); source.query.token = 'share';
    const url = issue(channel, { requireMappedChannel: true }, source);
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [user.id] });
    expect(await resolve(url)).not.toBeNull();
    db.prepare('UPDATE user_channels SET is_hidden = 1 WHERE id = ?').run(user.id);
    expect(await resolve(url)).toBeNull();
    db.prepare('UPDATE user_channels SET is_hidden = 0 WHERE id = ?').run(user.id);
    getXtreamUser.mockResolvedValue({ ...user, is_share_guest: true, allowed_channels: [] });
    expect(await resolve(url)).toBeNull();
    getXtreamUser.mockResolvedValue(user);
    db.prepare('UPDATE provider_channels SET epg_channel_id = ? WHERE id = ?').run('other.epg', user.id);
    expect(await resolve(url)).toBeNull();
  });
});
