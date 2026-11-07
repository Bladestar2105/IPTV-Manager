import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const password = 'archive-password';
const secret = 'JBSWY3DPEHPK3PXP';
const previousDirectory = process.env.DATA_DIR;
const previousKey = process.env.ENCRYPTION_KEY;
let directory;
const databases = [];
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn() });
async function installation(name, key) {
  process.env.DATA_DIR = path.join(directory, name);
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  process.env.ENCRYPTION_KEY = key.repeat(32);
  vi.resetModules();
  const { default: db, initDb } = await import('../../src/database/db.js');
  const crypto = await import('../../src/utils/crypto.js');
  const controller = await import('../../src/controllers/systemDataController.js');
  initDb(true);
  databases.push(db);
  return { db, crypto, controller };
}
function addUser(install, encryptedSecret = install.crypto.encrypt(secret)) {
  install.db.prepare(`INSERT INTO users(username, password, otp_enabled, otp_secret)
    VALUES('portable-user', 'hash', 1, ?)`).run(encryptedSecret);
}
async function importArchive(install, data) {
  const file = path.join(directory, 'archive.bin');
  fs.writeFileSync(file, Buffer.isBuffer(data) ? data : install.crypto.encryptWithPassword(zlib.gzipSync(JSON.stringify(data)), password));
  const res = response();
  await install.controller.importData({ user: { is_admin: true }, body: { password }, file: { path: file } }, res);
  return res;
}
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-otp-portability-')); });
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousKey;
});

it('roundtrips enabled OTP through an encrypted archive across distinct installation keys', async () => {
  const source = await installation('source', '11');
  addUser(source);
  const res = response();
  source.controller.exportData({ user: { is_admin: true }, body: { password }, query: {} }, res);
  const archive = res.send.mock.calls[0][0];
  const data = JSON.parse(zlib.gunzipSync(source.crypto.decryptWithPassword(archive, password)));
  expect(data.otp_secret_encoding).toBe('plaintext-v1');
  expect(data.users[0].otp_secret).toBe(secret);
  const sourceCiphertext = source.db.prepare("SELECT otp_secret FROM users WHERE username='portable-user'").get().otp_secret;
  const destination = await installation('destination', '22');
  expect(destination.crypto.decrypt(sourceCiphertext)).toBeNull();
  const imported = await importArchive(destination, archive);
  expect(imported.status).not.toHaveBeenCalled();
  const user = destination.db.prepare("SELECT otp_enabled, otp_secret FROM users WHERE username='portable-user'").get();
  expect(user.otp_enabled).toBe(1);
  expect(destination.crypto.decrypt(user.otp_secret)).toBe(secret);
  expect(source.crypto.decrypt(user.otp_secret)).toBeNull();
});

it('imports legacy ciphertext when this installation can decrypt it', async () => {
  const destination = await installation('destination', '22');
  const res = await importArchive(destination, { version: 2, users: [{ id: 7, username: 'portable-user', password: 'hash', otp_enabled: 1, otp_secret: destination.crypto.encrypt(secret) }] });
  expect(res.status).not.toHaveBeenCalled();
  const user = destination.db.prepare("SELECT otp_enabled, otp_secret FROM users WHERE username='portable-user'").get();
  expect(user.otp_enabled).toBe(1);
  expect(destination.crypto.decrypt(user.otp_secret)).toBe(secret);
});

it('rejects an unreadable legacy OTP secret atomically instead of importing broken enabled OTP', async () => {
  const source = await installation('source', '11');
  const ciphertext = source.crypto.encrypt(secret);
  const destination = await installation('destination', '22');
  const res = await importArchive(destination, { version: 2, users: [
    { id: 6, username: 'before-failure', password: 'hash' },
    { id: 7, username: 'portable-user', password: 'hash', otp_enabled: 1, otp_secret: ciphertext },
  ] });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'otp_secret_unavailable' }));
  expect(destination.db.prepare("SELECT username FROM users WHERE username IN ('portable-user', 'before-failure')").all()).toEqual([]);
});

it('refuses to export an enabled OTP secret that cannot be decrypted', async () => {
  const source = await installation('source', '11');
  addUser(source, 'broken-ciphertext');
  const res = response();
  source.controller.exportData({ user: { is_admin: true }, body: { password }, query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.send).not.toHaveBeenCalled();
});
