// 「文件夹已在哪个主窗口打开」的判定(VSCode findWindowOnWorkspaceOrFolder 同语义)。
import { describe, expect, it, vi } from 'vitest';
import {
  findWindowWithWorkspace,
  isSameWorkspacePath,
} from '../../../electron/main/services/workspace-window-lookup.service';

const identity = async (p: string) => p;

describe('findWindowWithWorkspace', () => {
  it('某个窗口的 root 与目标相同 → 返回该窗口 id', async () => {
    const id = await findWindowWithWorkspace(
      '/u/ws-x',
      [
        { windowId: 1, root: '/u/ws-a' },
        { windowId: 2, root: '/u/ws-x' },
      ],
      { realpath: identity, platform: 'darwin' },
    );
    expect(id).toBe(2);
  });

  it('没有窗口打开它 → null', async () => {
    const id = await findWindowWithWorkspace('/u/ws-x', [{ windowId: 1, root: '/u/ws-a' }], {
      realpath: identity,
      platform: 'darwin',
    });
    expect(id).toBeNull();
  });

  it('子目录 / 父目录不算同一工作区', async () => {
    const deps = { realpath: identity, platform: 'darwin' as const };
    expect(await findWindowWithWorkspace('/u/ws-x/sub', [{ windowId: 1, root: '/u/ws-x' }], deps)).toBeNull();
    expect(await findWindowWithWorkspace('/u/ws-x', [{ windowId: 1, root: '/u/ws-x/sub' }], deps)).toBeNull();
  });

  it('两侧都先 realpath:软链 / 不同写法指向同一目录 → 命中', async () => {
    const realpath = vi.fn(async (p: string) => (p === '/link/ws' ? '/real/ws' : p));
    const id = await findWindowWithWorkspace('/link/ws', [{ windowId: 5, root: '/real/ws' }], {
      realpath,
      platform: 'darwin',
    });
    expect(id).toBe(5);
    expect(realpath).toHaveBeenCalledWith('/link/ws');
    expect(realpath).toHaveBeenCalledWith('/real/ws');
  });

  it('realpath 失败(目录已不在等)→ 按原值比较,不抛', async () => {
    const realpath = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    expect(
      await findWindowWithWorkspace('/u/gone', [{ windowId: 3, root: '/u/gone' }], { realpath, platform: 'darwin' }),
    ).toBe(3);
  });

  it('尾分隔符无关;Windows 大小写与分隔符不敏感', async () => {
    expect(
      await findWindowWithWorkspace('/u/ws/', [{ windowId: 1, root: '/u/ws' }], { realpath: identity, platform: 'linux' }),
    ).toBe(1);
    expect(
      await findWindowWithWorkspace('c:/code/proj', [{ windowId: 9, root: 'C:\\Code\\Proj\\' }], {
        realpath: identity,
        platform: 'win32',
      }),
    ).toBe(9);
    // 非 Windows 区分大小写
    expect(
      await findWindowWithWorkspace('/u/WS', [{ windowId: 1, root: '/u/ws' }], { realpath: identity, platform: 'linux' }),
    ).toBeNull();
  });

  it('无候选窗口时不做任何 realpath', async () => {
    const realpath = vi.fn(identity);
    expect(await findWindowWithWorkspace('/u/ws', [], { realpath })).toBeNull();
    expect(realpath).not.toHaveBeenCalled();
  });
});

describe('isSameWorkspacePath', () => {
  it('双向包含 = 相等', () => {
    expect(isSameWorkspacePath('/a/b', '/a/b/', 'darwin')).toBe(true);
    expect(isSameWorkspacePath('/a/b', '/a/b/c', 'darwin')).toBe(false);
  });
});
