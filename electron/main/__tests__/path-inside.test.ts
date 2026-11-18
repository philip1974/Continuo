// 主进程统一的「路径等于或位于目录之下」判定(此前 mcp-tools-hook-bridge / debug.service 各写一份
// path.relative 判定)。Windows 按大小写不敏感(path.win32.relative 语义);posix 区分大小写。
import { describe, expect, it } from 'vitest';
import { isSameOrInsidePath } from '../lib/path-inside';

describe('isSameOrInsidePath(main)', () => {
  it('posix:相等 / 子孙为真,兄弟前缀 / 祖先 / 外部为假', () => {
    expect(isSameOrInsidePath('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isSameOrInsidePath('/a/b', '/a/b/c/d', 'linux')).toBe(true);
    expect(isSameOrInsidePath('/a/b/', '/a/b/c', 'linux')).toBe(true);
    expect(isSameOrInsidePath('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(isSameOrInsidePath('/a/b', '/a', 'linux')).toBe(false);
    expect(isSameOrInsidePath('/a/b', '/a/b/../c', 'linux')).toBe(false);
    expect(isSameOrInsidePath('/a/b', '/x/y', 'linux')).toBe(false);
  });

  it('posix 区分大小写', () => {
    expect(isSameOrInsidePath('/a/B', '/a/b/c', 'linux')).toBe(false);
    expect(isSameOrInsidePath('/a/B', '/a/b/c', 'darwin')).toBe(false);
  });

  it('名为 `..x` 的子目录仍算在内(不按字符串前缀 `..` 误判)', () => {
    expect(isSameOrInsidePath('/a', '/a/..x/y', 'linux')).toBe(true);
  });

  it('Windows:大小写不敏感、跨盘符为假', () => {
    expect(isSameOrInsidePath('C:\\Repo', 'c:\\repo\\src\\a.ts', 'win32')).toBe(true);
    expect(isSameOrInsidePath('C:\\Repo', 'C:\\REPO', 'win32')).toBe(true);
    expect(isSameOrInsidePath('C:\\Repo', 'C:\\Repo2\\a', 'win32')).toBe(false);
    expect(isSameOrInsidePath('C:\\Repo', 'D:\\Repo\\a', 'win32')).toBe(false);
  });
});
