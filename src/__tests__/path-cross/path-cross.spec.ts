import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  joinPath,
  stripRootPrefix,
  pathEquals,
  isSameOrInsidePath,
} from '../../lib/path-cross';

describe('joinPath — 沿用目录活动分隔符', () => {
  it('POSIX 目录用 /', () => {
    expect(joinPath('/work/dir', 'a.ts')).toBe('/work/dir/a.ts');
    expect(joinPath('/work/dir/', 'a.ts')).toBe('/work/dir/a.ts'); // 去尾斜杠
  });
  it('Windows 反斜杠目录用 \\', () => {
    expect(joinPath('C:\\work\\dir', 'a.ts')).toBe('C:\\work\\dir\\a.ts');
    expect(joinPath('C:\\work\\dir\\', 'a.ts')).toBe('C:\\work\\dir\\a.ts');
  });
  it('盘符根 C: 用 \\', () => {
    expect(joinPath('C:', 'a.ts')).toBe('C:\\a.ts');
  });
  it('正斜杠盘符目录保留 /', () => {
    expect(joinPath('C:/work', 'a.ts')).toBe('C:/work/a.ts');
  });
});

describe('stripRootPrefix — 分隔符无关剥前缀', () => {
  it('POSIX', () => {
    expect(stripRootPrefix('/root', '/root/src/a.ts')).toBe('src/a.ts');
    expect(stripRootPrefix('/root/', '/root/a.ts')).toBe('a.ts');
  });
  it('Windows 反斜杠', () => {
    expect(stripRootPrefix('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe(
      'src\\a.ts',
    );
  });
  it('不在 root 下 → 原样返回', () => {
    expect(stripRootPrefix('/root', '/other/a.ts')).toBe('/other/a.ts');
  });
  // 跨平台审计 P2(codex):路径边界 —— `/root` 不应错剥同前缀的 `/rooted/a`(旧裸
  // startsWith 会切成 `ed/a`)。
  it('同前缀非子目录(边界)→ 原样返回', () => {
    expect(stripRootPrefix('/root', '/rooted/a.ts')).toBe('/rooted/a.ts');
  });
  it('Windows 大小写不敏感(运行时)→ 仍剥成相对路径', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      expect(stripRootPrefix('c:\\repo', 'C:\\Repo\\src\\a.ts')).toBe(
        'src\\a.ts',
      );
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });
});

describe('pathEquals — 平台感知路径相等', () => {
  const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
  afterEach(() => {
    if (orig) Object.defineProperty(navigator, 'platform', orig);
    vi.unstubAllGlobals();
  });
  function setPlatform(p: string) {
    Object.defineProperty(navigator, 'platform', {
      value: p,
      configurable: true,
    });
  }

  it('完全相同 → true(任何平台)', () => {
    setPlatform('MacIntel');
    expect(pathEquals('/proj', '/proj')).toBe(true);
  });
  it('非 Windows:大小写不同 → false(严格,字节等价 ===)', () => {
    setPlatform('MacIntel');
    expect(pathEquals('/Proj', '/proj')).toBe(false);
  });
  it('Windows:大小写不同 → true(文件系统不敏感)', () => {
    setPlatform('Win32');
    expect(pathEquals('C:\\Repo', 'c:\\repo')).toBe(true);
    expect(pathEquals('C:\\Repo', 'C:\\Other')).toBe(false);
  });
});

// 跨平台审计 P2(codex):workspace root 归属 / 删除 / 改名 / 展开 路径包含的单一来源。
describe('isSameOrInsidePath — 路径包含(分隔符 + 平台感知大小写)', () => {
  const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
  afterEach(() => {
    if (orig) Object.defineProperty(navigator, 'platform', orig);
    vi.unstubAllGlobals();
  });
  function setPlatform(p: string) {
    Object.defineProperty(navigator, 'platform', { value: p, configurable: true });
  }

  it('精确相等 / 子路径 / 兄弟前缀(基本)', () => {
    setPlatform('MacIntel');
    expect(isSameOrInsidePath('/repo', '/repo')).toBe(true);
    expect(isSameOrInsidePath('/repo', '/repo/a.md')).toBe(true);
    expect(isSameOrInsidePath('/repo', '/repo/sub/b.md')).toBe(true);
    expect(isSameOrInsidePath('/repo', '/repofoo.md')).toBe(false); // 同前缀非子
    expect(isSameOrInsidePath('/repo', '/other/a.md')).toBe(false);
  });

  it('尾部分隔符无关 + 文件系统根', () => {
    setPlatform('MacIntel');
    expect(isSameOrInsidePath('/repo/', '/repo/a.md')).toBe(true);
    expect(isSameOrInsidePath('/', '/anything/x')).toBe(true); // POSIX 根含一切
  });

  it('POSIX:大小写敏感(/Repo ≠ /repo)', () => {
    setPlatform('MacIntel');
    expect(isSameOrInsidePath('/repo', '/Repo/a.md')).toBe(false);
  });

  it('Windows:大小写不敏感 + 分隔符 + 盘根', () => {
    setPlatform('Win32');
    expect(isSameOrInsidePath('c:\\repo', 'C:\\Repo\\a.md')).toBe(true);
    expect(isSameOrInsidePath('C:\\Repo', 'c:\\repo')).toBe(true); // 精确(折叠)
    expect(isSameOrInsidePath('C:\\', 'c:\\foo')).toBe(true); // 盘根含其下
    expect(isSameOrInsidePath('C:\\repo', 'C:\\other\\a.md')).toBe(false);
  });
});
