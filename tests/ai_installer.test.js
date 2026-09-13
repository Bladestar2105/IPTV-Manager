import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const temporary = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-ai-installer-'));
  temporary.push(directory);
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(directory, 'commands');
  fs.writeFileSync(log, '');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('id', '[ "$1" = "-u" ] && echo "${TEST_UID:-0}"; exit 0');
  stub('apt-get', 'echo "apt-get $*" >> "$TEST_LOG"; exit "${APT_STATUS:-0}"');
  stub('npm', 'echo "npm $*" >> "$TEST_LOG"; [ "$1" != "-v" ] || echo 11.0.0');
  stub('runuser', 'echo "runuser $*" >> "$TEST_LOG"; exit "${PREFLIGHT_STATUS:-0}"');
  const enabled = path.join(directory, 'apparmor-enabled');
  fs.writeFileSync(enabled, 'N\n');
  const helper = path.join(directory, 'install-ai-runtime.sh');
  fs.writeFileSync(helper, fs.readFileSync(path.join(root, 'scripts/install-ai-runtime.sh'), 'utf8')
    .replaceAll('/sys/module/apparmor/parameters/enabled', enabled));
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log };
  return { directory, helper, enabled, stub, env, commands: () => fs.readFileSync(log, 'utf8'), run: (script, extra = {}) => spawnSync('/bin/bash', [script], { env: { ...env, ...extra }, encoding: 'utf8' }) };
}

describe('AI runtime installers', () => {
  it('installs the tested runtime and sandbox, without changing application data', () => {
    const h = harness();
    const result = h.run(h.helper);
    expect(result.status, result.stderr).toBe(0);
    expect(h.commands().split('\n').filter(Boolean)).toEqual([
      'apt-get update',
      'apt-get install -y --no-install-recommends bubblewrap',
      'npm install --global @openai/codex@0.154.0',
    ]);
  });

  it('stops before installation without root and after a package failure', () => {
    const h = harness();
    const script = h.helper;
    expect(h.run(script, { TEST_UID: '1000' }).status).not.toBe(0);
    expect(h.commands()).toBe('');
    expect(h.run(script, { APT_STATUS: '23' }).status).toBe(23);
    expect(h.commands()).toBe('apt-get update\n');
  });

  it.each([0, 1])('uses a dedicated sandbox on AppArmor hosts without stopping installation on policy denial: %s', (parserStatus) => {
    const h = harness();
    fs.writeFileSync(h.enabled, 'Y\n');
    h.stub('install', 'echo "install $*" >> "$TEST_LOG"');
    h.stub('apparmor_parser', 'echo "apparmor_parser $*" >> "$TEST_LOG"; exit "${PARSER_STATUS:-0}"');
    const result = h.run(h.helper, { PARSER_STATUS: String(parserStatus) });
    expect(result.status, result.stderr).toBe(0);
    expect(h.commands()).toContain('install -D -o root -g root -m 0755 /usr/bin/bwrap /usr/local/lib/iptv-manager/bwrap');
    expect(h.commands()).toContain('apparmor_parser -r /etc/apparmor.d/iptv-manager-bwrap');
    if (parserStatus) expect(result.stdout).toContain('WARNING: Could not load the ChatGPT sandbox policy');
  });

  it.each([['', 0], ['AI_CODEX_ENABLED=false\n', 0], ['', 1]])('provisions fresh installs and preserves explicit choices: %s, preflight=%s', (setting, preflightStatus) => {
    const h = harness();
    const install = path.join(h.directory, 'application');
    const fixture = path.join(h.directory, 'repository');
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    fs.copyFileSync(h.helper, path.join(fixture, 'scripts/install-ai-runtime.sh'));
    const before = `INITIAL_ADMIN_PASSWORD=installer-test\n${setting}`;
    fs.writeFileSync(path.join(fixture, '.env.example'), before);
    h.stub('curl', 'exit 0');
    h.stub('node', 'echo v24.0.0');
    h.stub('git', '[ "$1" = clone ] || exit 1; mkdir -p "$3"; cp -R "$TEST_REPO/." "$3/"');
    h.stub('chown', 'exit 0');
    h.stub('systemctl', 'echo "systemctl $*" >> "$TEST_LOG"');
    h.stub('hostname', 'echo 127.0.0.1');
    h.stub('ufw', 'exit 0');
    const service = path.join(h.directory, 'iptv-manager.service');
    const script = fs.readFileSync(path.join(root, 'scripts/install.sh'), 'utf8')
      .replace('"$EUID"', '"$(id -u)"')
      .replace('INSTALL_DIR="/opt/iptv-manager"', `INSTALL_DIR="${install}"`)
      .replace('SERVICE_FILE="/etc/systemd/system/iptv-manager.service"', `SERVICE_FILE="${service}"`);
    const filename = path.join(h.directory, 'install.sh');
    fs.writeFileSync(filename, script);
    const result = h.run(filename, { TEST_REPO: fixture, PREFLIGHT_STATUS: String(preflightStatus) });
    expect(result.status, result.stderr).toBe(0);
    expect(h.commands()).toContain('npm install --global @openai/codex@0.154.0');
    expect(fs.readFileSync(path.join(install, '.env'), 'utf8')).toBe(setting ? before : `${before}\nAI_CODEX_ENABLED=true\n`);
    expect(fs.readFileSync(service, 'utf8')).toContain('User=iptv-manager\n');
    expect(h.commands()).toContain('systemctl start iptv-manager');
    expect(h.commands()).toContain('runuser -u iptv-manager -- node scripts/check-ai-runtime.mjs --if-enabled');
    expect(h.commands().indexOf('runuser ')).toBeLessThan(h.commands().indexOf('systemctl start'));
    if (preflightStatus) {
      expect(result.stdout).toContain('WARNING: ChatGPT is unavailable');
      expect(result.stdout).not.toContain('Completed Successfully');
    }
  });

  it.each([[undefined, 0], ['AI_CODEX_ENABLED=false\n', 0], [' export AI_CODEX_ENABLED = false\n', 0], ['AI_CODEX_ENABLED: false\n', 0], [undefined, 1]])('updates without replacing existing configuration: %s, preflight=%s', (setting, preflightStatus) => {
    const h = harness();
    const install = path.join(h.directory, 'application');
    fs.mkdirSync(path.join(install, 'scripts'), { recursive: true });
    fs.copyFileSync(h.helper, path.join(install, 'scripts/install-ai-runtime.sh'));
    const before = `AI_CODEX_BIN=/custom/codex\n${setting ?? ''}`;
    fs.writeFileSync(path.join(install, '.env'), before);
    fs.writeFileSync(path.join(install, 'db.sqlite'), 'existing data');
    h.stub('node', '[ "$1" = "-p" ] && echo 24 || echo v24.0.0');
    h.stub('sudo', 'shift 2; exec "$@"');
    h.stub('git', 'echo "git $*" >> "$TEST_LOG"');
    h.stub('systemctl', 'echo "systemctl $*" >> "$TEST_LOG"');
    h.stub('chown', 'echo "chown $*" >> "$TEST_LOG"');
    h.stub('hostname', 'echo 127.0.0.1');
    // Relocate only host paths and root identity; execute all installer logic.
    const script = fs.readFileSync(path.join(root, 'scripts/update.sh'), 'utf8')
      .replace('"$EUID"', '"$(id -u)"')
      .replace('INSTALL_DIR="/opt/iptv-manager"', `INSTALL_DIR="${install}"`);
    const filename = path.join(h.directory, 'update.sh');
    fs.writeFileSync(filename, script);
    const result = h.run(filename, { PREFLIGHT_STATUS: String(preflightStatus) });
    expect(result.status, result.stderr).toBe(0);
    expect(h.commands()).toContain('npm install --global @openai/codex@0.154.0');
    expect(fs.readFileSync(path.join(install, '.env'), 'utf8')).toBe(setting ? before : `${before}\nAI_CODEX_ENABLED=true\n`);
    expect(fs.readFileSync(path.join(install, 'db.sqlite'), 'utf8')).toBe('existing data');
    expect(h.commands().trim().endsWith('systemctl start iptv-manager')).toBe(true);
    expect(h.commands()).toContain('runuser -u iptv-manager -- node scripts/check-ai-runtime.mjs --if-enabled');
    if (preflightStatus) {
      expect(result.stdout).toContain('WARNING: ChatGPT is unavailable');
      expect(result.stdout).not.toContain('Completed Successfully');
    }
  });
});
