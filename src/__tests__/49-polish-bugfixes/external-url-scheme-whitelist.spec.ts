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
import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl } from '../../../electron/main/services/shell.service';

const ROOT = join(__dirname, '..', '..', '..');

describe('topic49 6thS · external URL scheme whitelist', () => {
  it('放行 http/https/mailto', () => {
    expect(isAllowedExternalUrl('https://github.com/x/y')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.com')).toBe(true);
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
    expect(src).toMatch(/if \(isAllowedExternalUrl\(url\)\)\s*\{\s*shell\.openExternal\(url\)/);
  });
});
