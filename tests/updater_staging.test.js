import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-update-staging-'));
  temporary.push(directory);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const source = path.join(directory, 'source'), remote = path.join(directory, 'remote.git'), install = path.join(directory, 'application');
  fs.mkdirSync(source);
  git(source, 'init', '-b', 'main');
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\ndb.sqlite\nnode_modules/\n.update.*/\n');
  fs.writeFileSync(path.join(source, 'README.md'), 'original documentation');
  function commit(version) {
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version }));
    fs.writeFileSync(path.join(source, 'package-lock.json'), version);
    git(source, 'add', '.'); git(source, 'commit', '-m', version);
    return git(source, 'rev-parse', 'HEAD');
  }
  const old = commit('1.0.0');
  git(directory, 'clone', '--bare', source, remote);
  git(directory, 'clone', remote, install);
  const target = commit('2.0.0');
  git(source, 'push', remote, 'main');
  fs.mkdirSync(path.join(install, 'node_modules'));
  fs.writeFileSync(path.join(install, 'node_modules', 'build'), '1.0.0');
  fs.writeFileSync(path.join(install, '.env'), 'AI_CODEX_ENABLED=false\n');
  fs.writeFileSync(path.join(install, 'db.sqlite'), 'existing data');
  const bin = path.join(directory, 'bin'), log = path.join(directory, 'commands');
  fs.mkdirSync(bin); fs.writeFileSync(log, '');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('id', 'echo 0');
  stub('runuser', 'shift 3; exec "$@"');
  stub('node', '[ "$1" != -p ] || echo 24');
  stub('chown', 'exit 0');
  stub('hostname', 'echo 127.0.0.1');
  stub('systemctl', 'echo "systemctl $*" >> "$TEST_LOG"; if [ "$1" = start ]; then [ "$FAIL_START" != always ] || exit 25; if [ "$FAIL_START" = 1 ]; then count=$(cat "$TEST_LOG.start" 2>/dev/null || echo 0); echo $((count+1)) > "$TEST_LOG.start"; [ "$count" != 0 ] || exit 25; fi; fi');
  stub('npm', 'if [ "$1" = -v ]; then echo 11; exit; fi; echo "npm $* in $PWD" >> "$TEST_LOG"; rm -rf node_modules; mkdir node_modules; cp package-lock.json node_modules/build; [ "$FAIL_CI" != 1 ] || exit 24; if [ -n "$TEST_NEXT_COMMIT" ]; then git --git-dir "$TEST_REMOTE" update-ref refs/heads/main "$TEST_NEXT_COMMIT"; fi');
  const script = path.join(directory, 'update.sh');
  fs.writeFileSync(script, fs.readFileSync(new URL('../scripts/update.sh', import.meta.url), 'utf8')
    .replace('"$EUID"', '"$(id -u)"').replace('INSTALL_DIR="/opt/iptv-manager"', `INSTALL_DIR="${install}"`));
  return { directory, install, target, old, commit, git, source, stub,
    commands: () => fs.readFileSync(log, 'utf8'),
    run: (extra = {}) => spawnSync('/bin/bash', [script], { env: { ...env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_REMOTE: remote, TEST_INSTALL: install, ...extra }, encoding: 'utf8' }) };
}

test('failed dependency installation leaves the running checkout and its usable modules untouched', () => {
  const h = fixture();
  const result = h.run({ FAIL_CI: '1' });
  expect(result.status, result.stderr).toBe(24);
  expect(h.git(h.install, 'rev-parse', 'HEAD')).toBe(h.old);
  expect(fs.readFileSync(path.join(h.install, 'node_modules/build'), 'utf8')).toBe('1.0.0');
  expect(h.commands()).not.toContain('systemctl stop');
  expect(fs.readdirSync(h.install).filter(name => name.startsWith('.update.'))).toEqual([]);
});

test('stages dependencies before stopping, then deploys precisely that commit even if remote main advances', () => {
  const h = fixture();
  const next = h.commit('3.0.0');
  // Make the next commit available without advancing the remote branch yet.
  h.git(h.source, 'push', path.join(h.directory, 'remote.git'), `${next}:refs/heads/next`);
  const result = h.run({ TEST_NEXT_COMMIT: next });
  expect(result.status, result.stderr).toBe(0);
  expect(h.git(h.install, 'rev-parse', 'HEAD')).toBe(h.target);
  expect(fs.readFileSync(path.join(h.install, 'node_modules/build'), 'utf8')).toBe('2.0.0');
  const commands = h.commands();
  expect(commands).toContain(`in ${h.install}/.update.`);
  expect(commands.indexOf('npm ci')).toBeLessThan(commands.indexOf('systemctl stop'));
  expect(fs.readFileSync(path.join(h.install, '.env'), 'utf8')).toBe('AI_CODEX_ENABLED=false\n');
  expect(fs.readFileSync(path.join(h.install, 'db.sqlite'), 'utf8')).toBe('existing data');
  expect(fs.readdirSync(h.install).filter(name => name.startsWith('.update.'))).toEqual([]);
});

test('local tracked edits are preserved and rejected before the service stops', () => {
  const h = fixture();
  fs.writeFileSync(path.join(h.install, 'README.md'), 'local changes');
  const result = h.run();
  expect(result.status).not.toBe(0);
  expect(h.git(h.install, 'rev-parse', 'HEAD')).toBe(h.old);
  expect(fs.readFileSync(path.join(h.install, 'README.md'), 'utf8')).toBe('local changes');
  expect(h.commands()).not.toContain('systemctl stop');
});

test('a failed start retries the matched code and dependency versions and still reports failure', () => {
  const h = fixture();
  const result = h.run({ FAIL_START: '1' });
  expect(result.status).toBe(25);
  expect(h.commands().split('\n').filter(line => line === 'systemctl start iptv-manager')).toHaveLength(2);
  expect(h.git(h.install, 'rev-parse', 'HEAD')).toBe(h.target);
  expect(fs.readFileSync(path.join(h.install, 'node_modules/build'), 'utf8')).toBe('2.0.0');
  expect(fs.readdirSync(h.install).filter(name => name.startsWith('.update.'))).toEqual([]);
});

test.each(['swap', 'merge'])('a failed %s restores usable old modules and leaves the original commit running', failure => {
  const h = fixture();
  if (failure === 'swap') h.stub('mv', 'case "$1" in "$TEST_INSTALL"/.update.*/node_modules) exit 26;; esac; exec /bin/mv "$@"');
  else h.stub('git', '[ "$1" != merge ] || exit 27; exec /usr/bin/git "$@"');
  const result = h.run();
  expect(result.status, result.stderr).toBe(failure === 'swap' ? 26 : 27);
  expect(h.git(h.install, 'rev-parse', 'HEAD')).toBe(h.old);
  expect(fs.readFileSync(path.join(h.install, 'node_modules/build'), 'utf8')).toBe('1.0.0');
  expect(h.commands()).toContain('systemctl start iptv-manager');
  expect(fs.readdirSync(h.install).filter(name => name.startsWith('.update.'))).toEqual([]);
});

test('unrecoverable service starts retain the previous dependencies for manual recovery', () => {
  const h = fixture();
  const result = h.run({ FAIL_START: 'always' });
  expect(result.status).toBe(25);
  const staging = fs.readdirSync(h.install).filter(name => name.startsWith('.update.'));
  expect(staging).toHaveLength(1);
  expect(fs.readFileSync(path.join(h.install, staging[0], 'previous-node_modules/build'), 'utf8')).toBe('1.0.0');
  expect(result.stderr).toContain('Recovery files retained');
});
