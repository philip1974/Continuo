import { describe, it, expect } from 'vitest';
import { pickDroppedDirectory } from '../../lib/window-drop';

// 模拟 DataTransfer 的 files(jsdom 不能直接造原生 DataTransfer)
function dt(files: ReadonlyArray<{ name: string }>): {
  files: ReadonlyArray<File>;
} {
  return { files: files as unknown as ReadonlyArray<File> };
}

describe('pickDroppedDirectory', () => {
  it('单个目录 drop → 返回路径', async () => {
    const data = dt([{ name: 'projA' }]);
    const r = await pickDroppedDirectory(data, () => '/abs/projA', async () => true);
    expect(r).toBe('/abs/projA');
  });

  it('单个文件 drop(isDir=false)→ null', async () => {
    const data = dt([{ name: 'a.md' }]);
    const r = await pickDroppedDirectory(data, () => '/abs/a.md', async () => false);
    expect(r).toBeNull();
  });

  it('混合(文件 + 目录)→ 取第一个目录', async () => {
    const data = dt([{ name: 'a.md' }, { name: 'projB' }, { name: 'projC' }]);
    const paths = ['/abs/a.md', '/abs/projB', '/abs/projC'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const isDir = async (p: string) => p !== '/abs/a.md';
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(r).toBe('/abs/projB');
  });

  it('多个目录 → 取第一个', async () => {
    const data = dt([{ name: 'projA' }, { name: 'projB' }]);
    const paths = ['/abs/projA', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const r = await pickDroppedDirectory(data, getPath, async () => true);
    expect(r).toBe('/abs/projA');
  });

  it('空 dataTransfer.files → null', async () => {
    const data = dt([]);
    const r = await pickDroppedDirectory(data, () => '', async () => true);
    expect(r).toBeNull();
  });

  it('getPath 返空 → 跳过该 entry', async () => {
    const data = dt([{ name: 'noPath' }, { name: 'projB' }]);
    const paths = ['', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const r = await pickDroppedDirectory(data, getPath, async () => true);
    expect(r).toBe('/abs/projB');
  });

  it('isDir 抛错 → 视为非目录,继续后续 entry', async () => {
    const data = dt([{ name: 'broken' }, { name: 'projB' }]);
    const paths = ['/abs/broken', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const isDir = async (p: string) => {
      if (p === '/abs/broken') throw new Error('EACCES');
      return true;
    };
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(r).toBe('/abs/projB');
  });
});
