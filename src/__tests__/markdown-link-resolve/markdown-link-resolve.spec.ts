import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveLink } from '../../panels/Editor/link-resolve';

describe('resolveLink — external scheme', () => {
  it('http:// → external', () => {
    expect(resolveLink('http://example.com', null)).toEqual({
      kind: 'external',
      url: 'http://example.com',
    });
  });
  it('https:// → external', () => {
    expect(resolveLink('https://example.com/path?q=1', null)).toEqual({
      kind: 'external',
      url: 'https://example.com/path?q=1',
    });
  });
  it('mailto: → external', () => {
    expect(resolveLink('mailto:foo@bar.com', null)).toEqual({
      kind: 'external',
      url: 'mailto:foo@bar.com',
    });
  });

  it('scheme 判断走字符扫描,不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(resolveLink('HTTPS://example.com', null)).toEqual({
        kind: 'external',
        url: 'HTTPS://example.com',
      });
      expect(resolveLink('custom+scheme://x', '/x.md')).toBeNull();
      expect(resolveLink('1bad://x', '/x.md')).toEqual({
        kind: 'file',
        absPath: '/1bad:/x',
      });
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });
});

describe('resolveLink — 不安全 / 未知 scheme → null', () => {
  it('安全 S6:file: scheme → null(不再当 external,避免经 OS openExternal 打开本地文件/UNC)', () => {
    expect(resolveLink('file:///etc/hosts', null)).toBeNull();
    expect(resolveLink('file://attacker/share', null)).toBeNull();
  });
  it('javascript: → null', () => {
    expect(resolveLink('javascript:alert(1)', '/x.md')).toBeNull();
  });
  it('tel: → null', () => {
    expect(resolveLink('tel:12345', '/x.md')).toBeNull();
  });
  it('自定义 scheme → null', () => {
    expect(resolveLink('myapp://x', '/x.md')).toBeNull();
  });
});

describe('resolveLink — 锚点', () => {
  it('纯锚点 #section → null(IDE 不接管文档内导航)', () => {
    expect(resolveLink('#heading', '/x.md')).toBeNull();
  });
  // markdown 里带空格 / 非 ASCII 的文件名按 URL 规则写成 percent-encoding;不解码就会去打开字面名为
  // `my%20notes.md` 的文件。
  it.each([
    ['my%20notes.md', '/work/docs/my notes.md'],
    ['%E4%B8%AD%E6%96%87.md', '/work/docs/中文.md'],
    ['sub/a%20b.md#sec', '/work/docs/sub/a b.md'],
  ])('percent-encoded 路径 %s → 解码后的文件路径', (href, absPath) => {
    expect(resolveLink(href, '/work/docs/index.md')).toEqual({ kind: 'file', absPath });
  });

  it('非法的 percent 序列(如 100%.md)→ 保留原样,不抛', () => {
    expect(resolveLink('100%.md', '/work/docs/index.md')).toEqual({
      kind: 'file',
      absPath: '/work/docs/100%.md',
    });
  });

  it('file.md#section → file,锚点切掉', () => {
    expect(resolveLink('./other.md#sec', '/work/x.md')).toEqual({
      kind: 'file',
      absPath: '/work/other.md',
    });
  });
});

describe('resolveLink — file 路径', () => {
  it('本地路径 normalize 不通过 split 物化所有路径段', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(resolveLink('./d/./e/../f.md', '/work/cur.md')).toEqual({
        kind: 'file',
        absPath: '/work/d/f.md',
      });
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('本地路径 normalize 预分配路径段数组,不通过 segs.push 扩容', () => {
    expect(resolveLink('./d/./e/../f.md', '/work/cur.md')).toEqual({
      kind: 'file',
      absPath: '/work/d/f.md',
    });
    const source = readFileSync(
      path.join(process.cwd(), 'src/panels/Editor/link-resolve.ts'),
      'utf-8',
    );
    expect(source).not.toContain('segs.push(');
  });

  it('绝对路径 / 开头 → file,直接用', () => {
    expect(resolveLink('/abs/x.md', '/work/cur.md')).toEqual({
      kind: 'file',
      absPath: '/abs/x.md',
    });
  });
  it('相对(./x.md)→ 当前文件目录拼接', () => {
    expect(resolveLink('./x.md', '/work/dir/cur.md')).toEqual({
      kind: 'file',
      absPath: '/work/dir/x.md',
    });
  });
  it('相对(无前缀 x.md)→ 当前文件目录拼接', () => {
    expect(resolveLink('x.md', '/work/dir/cur.md')).toEqual({
      kind: 'file',
      absPath: '/work/dir/x.md',
    });
  });
  it('相对(../sib/y.md)→ 解析 ..', () => {
    expect(resolveLink('../sib/y.md', '/work/dir/cur.md')).toEqual({
      kind: 'file',
      absPath: '/work/sib/y.md',
    });
  });
  it('多层 ../../', () => {
    expect(resolveLink('../../top.md', '/a/b/c/cur.md')).toEqual({
      kind: 'file',
      absPath: '/a/top.md',
    });
  });
  it('./ 段被去掉', () => {
    expect(resolveLink('./d/./e/f.md', '/work/cur.md')).toEqual({
      kind: 'file',
      absPath: '/work/d/e/f.md',
    });
  });
});

describe('resolveLink — 不可解析', () => {
  it('空 href → null', () => {
    expect(resolveLink('', '/x.md')).toBeNull();
  });
  it('相对路径 + currentFilePath=null → null', () => {
    expect(resolveLink('./x.md', null)).toBeNull();
  });
  it('相对路径 + currentFilePath 无目录(裸文件名)→ null', () => {
    // 比如 untitled-xxx 这种没目录的 id,无法解析相对
    expect(resolveLink('./x.md', 'untitled-abc')).toBeNull();
  });
});

describe('resolveLink — Windows 路径', () => {
  it('反斜杠相对路径从 Windows 当前文件解析(归一为全反斜杠)', () => {
    expect(resolveLink('x.md', 'C:\\work\\cur.md')).toEqual({
      kind: 'file',
      absPath: 'C:\\work\\x.md',
    });
  });

  it('Windows 盘符绝对路径(反斜杠)→ file,不被当 C: scheme 拒绝', () => {
    expect(resolveLink('C:\\work\\notes.md', '/cur.md')).toEqual({
      kind: 'file',
      absPath: 'C:\\work\\notes.md',
    });
  });

  it('Windows 盘符绝对路径(正斜杠)→ file,保留正斜杠', () => {
    expect(resolveLink('C:/work/notes.md', null)).toEqual({
      kind: 'file',
      absPath: 'C:/work/notes.md',
    });
  });

  it('UNC 绝对路径 → file,不当相对路径拼接(同 share 文档内)', () => {
    expect(resolveLink('\\\\server\\share\\f.md', '\\\\server\\share\\cur.md')).toEqual({
      kind: 'file',
      absPath: '\\\\server\\share\\f.md',
    });
  });

  it('Windows 绝对路径轻量判断不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');

    try {
      expect(resolveLink('C:\\work\\notes.md', '/cur.md')).toEqual({
        kind: 'file',
        absPath: 'C:\\work\\notes.md',
      });
      expect(resolveLink('\\\\server\\share\\f.md', '\\\\server\\share\\cur.md')).toEqual({
        kind: 'file',
        absPath: '\\\\server\\share\\f.md',
      });
      const windowsPathRegexCalls = testSpy.mock.contexts.filter(
        (context) =>
          context instanceof RegExp &&
          (context.source === '^[a-zA-Z]:[\\\\/]' || context.source === '^\\\\\\\\'),
      );
      expect(windowsPathRegexCalls).toHaveLength(0);
    } finally {
      testSpy.mockRestore();
    }
  });

  // 跨平台(复查 P2):UNC `\\server\share` 是不可越过的卷根,相对链接 `..` 不得弹出
  // host/share;旧实现 root 仅取 `\\` → `..\..` 越过 share 错解析成 `\\server\a.md`。
  it('UNC 工作区相对链接 .. 不越过 share 根', () => {
    // 从 \\server\share\dir\cur.md 解析 ..\..\a.md:dir 被弹后停在 share 根
    expect(
      resolveLink('..\\..\\a.md', '\\\\server\\share\\dir\\cur.md'),
    ).toEqual({
      kind: 'file',
      absPath: '\\\\server\\share\\a.md',
    });
  });

  it('UNC 同层相对链接正确解析', () => {
    expect(
      resolveLink('sub\\b.md', '\\\\server\\share\\dir\\cur.md'),
    ).toEqual({
      kind: 'file',
      absPath: '\\\\server\\share\\dir\\sub\\b.md',
    });
  });

  it('UNC 根解析走字符扫描,不调用 RegExp.exec', () => {
    const execSpy = vi.spyOn(RegExp.prototype, 'exec');

    try {
      expect(
        resolveLink('..\\..\\a.md', '\\\\server\\share\\dir\\cur.md'),
      ).toEqual({
        kind: 'file',
        absPath: '\\\\server\\share\\a.md',
      });
      expect(execSpy).not.toHaveBeenCalled();
    } finally {
      execSpy.mockRestore();
    }
  });

  it('Windows 风格相对路径 ..\\ 正确折叠', () => {
    expect(resolveLink('..\\sib\\y.md', 'C:\\work\\dir\\cur.md')).toEqual({
      kind: 'file',
      absPath: 'C:\\work\\sib\\y.md',
    });
  });
});

// 边界(E179):href 来自(可能恶意/损坏)文件内容,非经 IPC schema。超长链接点击会 normalize/split
// O(n) 或经 openExternal IPC structured-clone 放大 → 编辑器卡顿。href 加长度上限,超限直接 null。
describe('resolveLink — href 长度上限 (E179)', () => {
  it('超长外链(> 2048)→ null(不进 openExternal IPC)', () => {
    const url = 'https://example.com/' + 'a'.repeat(2100);
    expect(url.length).toBeGreaterThan(2048);
    expect(resolveLink(url, null)).toBeNull();
  });

  it('外链恰好 ≤2048 → 仍 external(回归)', () => {
    const url = 'https://e.com/' + 'a'.repeat(2000);
    expect(url.length).toBeLessThanOrEqual(2048);
    expect(resolveLink(url, null)).toEqual({ kind: 'external', url });
  });

  it('超长文件链接(> 8192)→ null(不进 normalize)', () => {
    const p = '/abs/' + 'd/'.repeat(5000) + 'f.md'; // > 8192
    expect(p.length).toBeGreaterThan(8192);
    expect(resolveLink(p, null)).toBeNull();
  });

  it('文件链接 ≤8192 → 仍 file(回归)', () => {
    const p = '/abs/' + 'x'.repeat(1000) + '.md';
    expect(p.length).toBeLessThanOrEqual(8192);
    expect(resolveLink(p, null)).toMatchObject({ kind: 'file' });
  });
});

// 安全(仅 Windows):markdown 里直接书写的 UNC 链接(`\\attacker@SSL\share\a.md`)点开后经
// coApi.fs.readFile → 主进程 lstat/open,Windows 会向攻击者主机发起 SMB/WebDAV 并自动 NTLMv2
// 认证 → 凭据哈希泄露。规则:解析结果是 UNC 时,只有当前文档本身位于**同一 server+share** 才放行
// (UNC 工作区内的链接照常可用);否则返回 null 不打开。设备命名空间 `\\?\` / `\\.\` 一律拒。
describe('resolveLink — 安全:拒绝跨主机 UNC 链接(NTLM 凭据泄露)', () => {
  it('本地文档中的 UNC 链接 → null', () => {
    expect(resolveLink('\\\\attacker.example@SSL\\share\\a.md', 'C:\\work\\cur.md')).toBeNull();
    expect(resolveLink('\\\\attacker\\share\\a.md', '/home/u/cur.md')).toBeNull();
  });

  it('无当前文档时的 UNC 链接 → null', () => {
    expect(resolveLink('\\\\attacker\\share\\a.md', null)).toBeNull();
  });

  it('percent 编码的 UNC 链接 → null', () => {
    expect(resolveLink('%5C%5Cattacker%5Cshare%5Ca.md', 'C:\\work\\cur.md')).toBeNull();
  });

  it('只有 server 无 share 的残缺 UNC → null', () => {
    expect(resolveLink('\\\\attacker', 'C:\\work\\cur.md')).toBeNull();
    expect(resolveLink('\\\\attacker\\', '\\\\attacker\\share\\cur.md')).toBeNull();
  });

  it('UNC 文档中指向其他 server 或 share 的链接 → null', () => {
    const cur = '\\\\server\\share\\dir\\cur.md';
    expect(resolveLink('\\\\attacker\\share\\a.md', cur)).toBeNull();
    expect(resolveLink('\\\\server\\other\\a.md', cur)).toBeNull();
  });

  it('UNC 文档中同 server+share 的链接放行(大小写不敏感)', () => {
    const cur = '\\\\server\\share\\dir\\cur.md';
    expect(resolveLink('\\\\SERVER\\Share\\a.md', cur)).toEqual({
      kind: 'file',
      absPath: '\\\\SERVER\\Share\\a.md',
    });
    expect(resolveLink('./a.md', cur)).toEqual({
      kind: 'file',
      absPath: '\\\\server\\share\\dir\\a.md',
    });
  });

  it('设备命名空间 \\\\?\\ / \\\\.\\ 链接 → null(含从设备路径文档出发的相对链接越根)', () => {
    expect(resolveLink('\\\\?\\UNC\\attacker\\share\\a.md', 'C:\\work\\cur.md')).toBeNull();
    expect(resolveLink('\\\\.\\pipe\\x', 'C:\\work\\cur.md')).toBeNull();
    expect(
      resolveLink('..\\..\\..\\..\\attacker\\s\\a.md', '\\\\?\\UNC\\server\\share\\dir\\cur.md'),
    ).toBeNull();
    expect(
      resolveLink('\\\\?\\UNC\\attacker\\s\\a.md', '\\\\?\\UNC\\server\\share\\cur.md'),
    ).toBeNull();
  });

  it('`//host/share` 与 `/\\host` 不产出 UNC(折叠为根下路径)', () => {
    for (const href of ['//attacker/share/a.md', '/\\attacker\\share\\a.md']) {
      const r = resolveLink(href, 'C:\\work\\cur.md');
      expect(r?.kind).toBe('file');
      const p = r?.kind === 'file' ? r.absPath : '';
      expect(/^[\\/]{2}/.test(p)).toBe(false);
    }
  });

  it('file: scheme 指向远程主机 → null', () => {
    expect(resolveLink('file://attacker/share/a.md', 'C:\\work\\cur.md')).toBeNull();
    expect(resolveLink('file:\\\\attacker\\share\\a.md', 'C:\\work\\cur.md')).toBeNull();
  });
});
