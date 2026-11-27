// @vitest-environment jsdom
// BDD: posix-backslash-filename / macOS / Linux 上 `\` 是文件名字符,只按 `/` 切分;Windows 照旧两种分隔符
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basename, dirname, joinPath, splitPathSegments } from '@/lib/path-cross';
import { basenameForChrome } from '@/lib/path-label';
import { basenamePreserveTrailing, recentRootLabelParts } from '@/panels/Explorer/path-utils';
import { tabLabelDescriptions } from '@/panels/Editor/tab-label-description';
import { isHiddenWithinRoot } from '@/panels/Explorer/tree-config';

let original: PropertyDescriptor | undefined;
function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, 'platform', { value: p, configurable: true });
}
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
});
afterEach(() => {
  if (original) Object.defineProperty(window.navigator, 'platform', original);
  else delete (window.navigator as { platform?: string }).platform;
});

describe.each(['MacIntel', 'Linux x86_64'])('%s', (platform) => {
  beforeEach(() => setPlatform(platform));

  it('tab / 标题 / 状态栏展示名:整个 `a\\b.txt`', () => {
    expect(basenameForChrome('/w/a\\b.txt')).toBe('a\\b.txt');
    expect(basename('/w/a\\b.txt')).toBe('a\\b.txt');
    expect(basenamePreserveTrailing('/w/a\\b.txt')).toBe('a\\b.txt');
    expect(recentRootLabelParts('/w/x\\y')).toEqual({ name: 'x\\y', parent: '/w' });
  });

  it('父目录与拼接:`\\` 不算分隔符', () => {
    expect(dirname('/w/a\\b.txt')).toBe('/w');
    expect(dirname('/w/x\\y/f.ts')).toBe('/w/x\\y');
    expect(joinPath('/w/x\\y', 'f.ts')).toBe('/w/x\\y/f.ts');
    expect(splitPathSegments('src/a\\b.ts')).toEqual(['src', 'a\\b.ts']);
  });

  it('同名 tab 的父目录后缀按 `/` 计算', () => {
    expect(tabLabelDescriptions(['/w/p\\q/a.ts', '/w/r/a.ts'])).toEqual(['p\\q', 'r']);
  });

  it('`x\\.y` 不以 `.` 开头 → 不算隐藏项', () => {
    expect(isHiddenWithinRoot('/w', '/w/x\\.y')).toBe(false);
    expect(isHiddenWithinRoot('/w', '/w/.x')).toBe(true);
  });
});

describe('Windows', () => {
  it('Windows 运行时:`\\` 照旧是分隔符', () => {
    setPlatform('Win32');
    expect(basenameForChrome('C:\\w\\a.txt')).toBe('a.txt');
    expect(basename('src\\a.ts')).toBe('a.ts');
    expect(dirname('C:\\w\\a.txt')).toBe('C:\\w');
    expect(joinPath('C:\\w', 'f.ts')).toBe('C:\\w\\f.ts');
  });

  it('非 Windows 运行时遇到 Windows 形态路径(盘符 / UNC)仍按 Windows 切分', () => {
    setPlatform('MacIntel');
    expect(basenameForChrome('C:\\w\\a.txt')).toBe('a.txt');
    expect(dirname('\\\\srv\\share\\a.txt')).toBe('\\\\srv\\share');
  });
});
