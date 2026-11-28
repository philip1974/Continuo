// BDD: external-link-trusted-domains / 受信域名匹配规则(main 判定与设置页共用的纯函数,对齐 VSCode isURLDomainTrusted)
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));
import {
  DEFAULT_TRUSTED_DOMAINS,
  TRUSTED_DOMAINS_MAX,
  isHttpUrl,
  isUrlTrusted,
  normalizeTrustedDomains,
  trustChoicesFor,
} from '../../../electron/shared/trusted-domains';
import { HELP_LINKS } from '../../../electron/main/help-links';

describe('isUrlTrusted', () => {
  it('精确源:scheme 与主机都要相同;不做隐式子域匹配', () => {
    const list = ['https://example.com'];
    expect(isUrlTrusted('https://example.com', list)).toBe(true);
    expect(isUrlTrusted('https://example.com/a/b?q=1#x', list)).toBe(true);
    expect(isUrlTrusted('http://example.com', list)).toBe(false);
    expect(isUrlTrusted('https://www.example.com', list)).toBe(false);
    expect(isUrlTrusted('https://example.com.evil.test', list)).toBe(false);
  });

  it('*.example.com 匹配 example.com 本身及任意层子域;不写 scheme 时 http / https 都匹配', () => {
    const list = ['*.example.com'];
    for (const u of ['https://example.com', 'http://a.example.com', 'https://a.b.example.com/x']) {
      expect(isUrlTrusted(u, list), u).toBe(true);
    }
    expect(isUrlTrusted('https://badexample.com', list)).toBe(false);
    expect(isUrlTrusted('https://example.com.evil.test', list)).toBe(false);
    expect(isUrlTrusted('http://a.example.com', ['https://*.example.com'])).toBe(false);
  });

  it('路径前缀按段匹配;github.com 路径不区分大小写', () => {
    const list = ['https://github.com/philip1974/Continuo'];
    expect(isUrlTrusted('https://github.com/philip1974/Continuo/issues', list)).toBe(true);
    expect(isUrlTrusted('https://github.com/PHILIP1974/continuo', list)).toBe(true);
    expect(isUrlTrusted('https://github.com/philip1974/Continuo-evil', list)).toBe(false);
    expect(isUrlTrusted('https://github.com/philip1974/Continuo/../../evil/repo', list)).toBe(false);
    expect(isUrlTrusted('https://github.com/other/repo', list)).toBe(false);
    expect(isUrlTrusted('https://example.com/A', ['https://example.com/a'])).toBe(false);
  });

  it('端口:不写 = 默认端口;:* = 任意端口', () => {
    expect(isUrlTrusted('https://example.com:8443', ['https://example.com'])).toBe(false);
    expect(isUrlTrusted('https://example.com:443', ['https://example.com'])).toBe(true);
    expect(isUrlTrusted('https://example.com:8443', ['https://example.com:*'])).toBe(true);
    expect(isUrlTrusted('http://10.0.0.1:8080', ['http://10.0.0.1:8080'])).toBe(true);
  });

  it('localhost / 127.0.0.1 / [::1] 始终受信;带用户信息的链接一律不受信', () => {
    expect(isUrlTrusted('http://localhost:3000', [])).toBe(true);
    expect(isUrlTrusted('http://127.0.0.1:5173/x', [])).toBe(true);
    expect(isUrlTrusted('http://[::1]:8080', [])).toBe(true);
    expect(isUrlTrusted('https://github.com@evil.test/philip1974/Continuo', DEFAULT_TRUSTED_DOMAINS)).toBe(false);
    expect(isUrlTrusted('https://user@example.com', ['https://example.com'])).toBe(false);
  });

  it('主机名按 punycode 比较:同形字域名不会被当成受信的 ASCII 域名', () => {
    expect(isUrlTrusted('https://exаmple.com', ['https://example.com'])).toBe(false); // а = U+0430
    expect(isUrlTrusted('https://EXAMPLE.com', ['https://example.com'])).toBe(true);
  });

  it('* 信任所有;非 http(s) 永远不算受信(那些由 scheme 白名单单独把关)', () => {
    expect(isUrlTrusted('https://anything.test', ['*'])).toBe(true);
    expect(isUrlTrusted('mailto:a@b.c', ['*'])).toBe(false);
    expect(isHttpUrl('mailto:a@b.c')).toBe(false);
    expect(isHttpUrl('HTTPS://x.test')).toBe(true);
  });

  it('默认受信 = 本应用仓库主页(帮助菜单的链接都在其下)', () => {
    for (const link of Object.values(HELP_LINKS)) expect(isUrlTrusted(link, DEFAULT_TRUSTED_DOMAINS), link).toBe(true);
    expect(isUrlTrusted('https://github.com/someone/else', DEFAULT_TRUSTED_DOMAINS)).toBe(false);
  });
});

describe('trustChoicesFor(「配置受信任的域」的选项)', () => {
  it('域名:信任源 / 信任末两级域名及所有子域 / 信任所有', () => {
    expect(trustChoicesFor('https://docs.example.com/a?b')).toEqual([
      { pattern: 'https://docs.example.com', label: 'https://docs.example.com', kind: 'origin' },
      { pattern: '*.example.com', label: 'example.com', kind: 'subdomains' },
      { pattern: '*', label: '*', kind: 'all' },
    ]);
  });

  it('IPv4 带端口:信任源 / 该地址所有端口 / 信任所有', () => {
    expect(trustChoicesFor('http://10.0.0.1:8080/x').map((c) => c.pattern)).toEqual([
      'http://10.0.0.1:8080',
      'http://10.0.0.1:*',
      '*',
    ]);
  });
});

describe('normalizeTrustedDomains', () => {
  it('去空白 / 空串 / 重复 / 非字符串 / 超长,限量', () => {
    expect(normalizeTrustedDomains([' a.test ', '', 'a.test', 3, 'x'.repeat(300), 'b.test'])).toEqual(['a.test', 'b.test']);
    expect(normalizeTrustedDomains(Array.from({ length: 600 }, (_, i) => `d${i}.test`))).toHaveLength(TRUSTED_DOMAINS_MAX);
  });
});
