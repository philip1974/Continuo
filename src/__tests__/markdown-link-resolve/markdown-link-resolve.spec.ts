import { describe, it, expect } from 'vitest';
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
  it('file.md#section → file,锚点切掉', () => {
    expect(resolveLink('./other.md#sec', '/work/x.md')).toEqual({
      kind: 'file',
      absPath: '/work/other.md',
    });
  });
});

describe('resolveLink — file 路径', () => {
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

  it('UNC 绝对路径 → file,不当相对路径拼接', () => {
    expect(resolveLink('\\\\server\\share\\f.md', '/cur.md')).toEqual({
      kind: 'file',
      absPath: '\\\\server\\share\\f.md',
    });
  });

  // 跨平台(codex 复查 P2):UNC `\\server\share` 是不可越过的卷根,相对链接 `..` 不得弹出
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
