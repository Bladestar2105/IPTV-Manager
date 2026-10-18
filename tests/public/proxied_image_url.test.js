import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadHelper(file, authenticated = true) {
  const source = readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8');
  const match = source.match(/([ ]*)function getProxiedUrl\(url\) \{[\s\S]*?\n\1\}/);
  const context = vm.createContext({
    URL, encodeURIComponent,
    window: { location: { href: 'https://manager.test/player.html', origin: 'https://manager.test' } },
    getToken: () => authenticated ? 'user-token' : '',
    token: authenticated === true ? 'user-token' : '',
    username: authenticated === 'credentials' ? 'client-user' : '',
    password: authenticated === 'credentials' ? 'client-pass' : '',
    getAuthParams: () => authenticated === 'credentials'
      ? 'username=client-user&password=client-pass' : authenticated ? 'token=user-token' : '',
  });
  vm.runInContext(match[0], context);
  return context.getProxiedUrl;
}

for (const file of ['app.js', 'player.js']) {
  describe(`${file} image proxy URLs`, () => {
    it('keeps Manager absolute URLs and local paths directly usable', () => {
      const proxy = loadHelper(file);
      for (const local of ['https://manager.test/api/proxy/resource/opaque/image.png', '/icons/logo.png', 'icons/logo.png']) {
        expect(proxy(local)).toBe(local);
      }
    });

    it('proxies protocol-relative and mixed-case external HTTP URLs', () => {
      const proxy = loadHelper(file);
      for (const external of ['//provider.test/private.png', 'HTTPS://provider.test/private.png']) {
        const output = new URL(proxy(external), 'https://manager.test');
        expect(output.pathname).toBe('/api/proxy/image');
        expect(output.searchParams.get('url')).toBe('https://provider.test/private.png');
        expect(output.searchParams.get('token')).toBe('user-token');
      }
    });

    it('never returns external images without authentication or unsafe schemes', () => {
      const proxy = loadHelper(file, false);
      expect(proxy('https://provider.test/private.png')).toBe('');
      expect(proxy('//provider.test/private.png')).toBe('');
      for (const unsafe of ['javascript:alert(1)', 'file:///tmp/logo', 'data:text/html,<img src=https://provider.test>']) {
        expect(proxy(unsafe)).toBe('');
      }
      expect(proxy('data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=');
    });
  });
}

it('keeps username/password client authentication on the player image proxy', () => {
  const proxy = loadHelper('player.js', 'credentials');
  const result = new URL(proxy('https://provider.test/poster.jpg'), 'https://manager.test');
  expect(result.pathname).toBe('/api/proxy/image');
  expect(result.searchParams.get('username')).toBe('client-user');
  expect(result.searchParams.get('password')).toBe('client-pass');
});
