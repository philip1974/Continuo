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

describe('resolveLink — Windows 路径(向后兼容)', () => {
  it('反斜杠路径 currentFilePath → 取反斜杠最后一段做目录', () => {
    expect(resolveLink('x.md', 'C:\\work\\cur.md')).toEqual({
      kind: 'file',
      absPath: 'C:\\work/x.md',
    });
  });
});
