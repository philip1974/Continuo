import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolveWatchChangedPath } from '../ipc/fs.ipc';

describe('resolveWatchChangedPath — watcher 变更目录路径(平台原生分隔符)', () => {
  it('POSIX:根文件 → 根;子目录文件 → 子目录(/)', () => {
    expect(resolveWatchChangedPath('/proj', 'a.ts')).toBe('/proj');
    expect(resolveWatchChangedPath('/proj', 'sub/dir/a.ts')).toBe(
      '/proj/sub/dir',
    );
  });

  it('Windows:用 path.win32 拼出原生反斜杠(不产生混合分隔符)', () => {
    // 注入 path.win32 模拟 Windows 运行时(生产环境 node:path 即 win32)。
    expect(
      resolveWatchChangedPath('C:\\proj', 'sub\\dir\\a.ts', path.win32),
    ).toBe('C:\\proj\\sub\\dir');
    expect(resolveWatchChangedPath('C:\\proj', 'a.ts', path.win32)).toBe(
      'C:\\proj',
    );
  });

  it('相对路径分隔符归一化走尾部扫描,不调用 String.replace', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace');
    try {
      expect(
        resolveWatchChangedPath('/proj', 'sub\\dir/a.ts', path.posix),
      ).toBe('/proj/sub/dir');
      expect(resolveWatchChangedPath('/proj', 'a.ts', path.posix)).toBe('/proj');
      expect(replaceSpy).not.toHaveBeenCalled();
    } finally {
      replaceSpy.mockRestore();
    }
  });
});
