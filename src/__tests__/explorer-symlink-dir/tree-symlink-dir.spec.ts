// @vitest-environment jsdom
// BDD: explorer-symlink-dir / 树层:符号链接目录是可展开文件夹;「全部展开」不跟随链接(循环链接不卡死)。
import { describe, expect, it, vi } from 'vitest';
import { createTree } from '@headless-tree/core';
import { createTreeConfig } from '../../panels/Explorer/tree-config';
import type { FileEntry, IpcResult } from '../../lib/fs/types';

// /work/real(目录)、/work/up-loop → /work(循环链接):每层 listDir 都再列出 up-loop。
// 循环在测试桩里截到 3 层(真实文件系统无限):回归时用例在有限步内以断言失败结束,而非挂死整个测试进程。
const MAX_LOOP_DEPTH = 3;
const loopDepth = (p: string) => p.split('/up-loop').length - 1;
const listDir = vi.fn(async (p: string): Promise<IpcResult<readonly FileEntry[]>> => {
  if (p === '/work' || (p.endsWith('/up-loop') && loopDepth(p) < MAX_LOOP_DEPTH)) {
    return {
      ok: true,
      data: [
        { path: `${p}/real`, name: 'real', isDirectory: true },
        { path: `${p}/up-loop`, name: 'up-loop', isDirectory: true, isSymlink: true },
      ],
    };
  }
  return { ok: true, data: [{ path: `${p}/f.ts`, name: 'f.ts', isDirectory: false }] };
});

function mountTree() {
  const tree = createTree<FileEntry>(createTreeConfig({ root: '/work', fs: { listDir } }));
  tree.setMounted(true);
  tree.rebuildTree();
  return tree;
}

async function loaded(tree: ReturnType<typeof mountTree>, id: string) {
  await vi.waitFor(() => expect(tree.getItems().some((i) => i.getId() === id)).toBe(true));
  return tree.getItemInstance(id);
}

describe('符号链接目录在树中', () => {
  it('isSymlink 且 isDirectory 的项是文件夹,可单独展开(列出链接下子项)', async () => {
    const tree = mountTree();
    const link = await loaded(tree, '/work/up-loop');
    expect(link.isFolder()).toBe(true);
    link.expand();
    await loaded(tree, '/work/up-loop/real');
  });

  it('「全部展开」跳过符号链接目录:有限步完成,不跟随循环链接', async () => {
    const tree = mountTree();
    await loaded(tree, '/work/up-loop');
    listDir.mockClear();
    await tree.expandAll();
    expect(tree.getState().expandedItems).toContain('/work/real');
    expect(tree.getState().expandedItems).not.toContain('/work/up-loop');
    expect(listDir).not.toHaveBeenCalledWith('/work/up-loop');
  });
});
