// Explorer 批量操作 · 嵌套选择(父目录与其子项同批)只处理最外层路径。
//
// 根因:多选 A 与 A/B 后复制 → A 子树(含 B)整体复制一次,B 再被单独复制一次(重复);移动 →
// A 先移走后 A/B 已不存在 → FS_NOT_FOUND 中途报错(或 A/B 先移走 → 层级被拆散);删除 → 删 A
// 后再删 A/B 报错。修:批量移动/复制漏斗 transferEntriesInto 与批量删除漏斗 removeItems 先用
// outermostPaths 剔除「祖先也在批次里」的后代项。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  transferEntriesInto,
  type BatchTransferDeps,
} from '../../panels/Explorer/batch-transfer';
import { removeItems, trashItemsAndCleanup } from '../../panels/Explorer/mutate-actions';
import { outermostPaths } from '../../panels/Explorer/path-utils';

type Result = { ok: true; data: undefined } | { ok: false; code: string; message: string };
const OK: Result = { ok: true, data: undefined };

function makeDeps() {
  const deps = {
    fs: {
      move: vi.fn(async (_s: string, _d: string): Promise<Result> => OK),
      copy: vi.fn(async (_s: string, _d: string): Promise<Result> => OK),
    },
    makeUniqueDestPicker: vi.fn(async (destDir: string) => (name: string) => `${destDir}/${name}`),
    refreshDir: vi.fn(),
    onMoved: vi.fn(),
    onItemFailed: vi.fn(),
    onException: vi.fn(),
  };
  return { deps: deps as unknown as BatchTransferDeps, spies: deps };
}

describe('outermostPaths', () => {
  it('剔除祖先也在批次里的后代项,保留输入顺序', () => {
    expect(outermostPaths(['/r/A/B', '/r/x.txt', '/r/A', '/r/A/B/c.txt'])).toEqual([
      '/r/x.txt',
      '/r/A',
    ]);
  });

  it('前缀相同但非祖先(/r/A 与 /r/AB)不误剔', () => {
    expect(outermostPaths(['/r/A', '/r/AB'])).toEqual(['/r/A', '/r/AB']);
  });

  it('重复路径只保留首个', () => {
    expect(outermostPaths(['/r/a', '/r/a'])).toEqual(['/r/a']);
  });

  it('Windows 分隔符同样识别祖先', () => {
    expect(outermostPaths(['C:\\r\\A\\B', 'C:\\r\\A'])).toEqual(['C:\\r\\A']);
  });
});

describe('transferEntriesInto — 嵌套选择', () => {
  it('copy [A, A/B] → 只复制 A 一次(不重复复制子树)', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('copy', ['/r/A', '/r/A/B'], '/d', deps);
    expect(spies.fs.copy.mock.calls).toEqual([['/r/A', '/d/A']]);
  });

  it('move [A/B, A] → 只移动 A(层级不被拆散,不中途报错)', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/r/A/B', '/r/A'], '/d', deps);
    expect(spies.fs.move.mock.calls).toEqual([['/r/A', '/d/A']]);
    expect(spies.onMoved.mock.calls).toEqual([['/r/A', '/d/A']]);
    expect(spies.onItemFailed).not.toHaveBeenCalled();
  });

  it('同父跳过:祖先因已在目标目录被跳过时,其后代也不单独移动', async () => {
    const { deps, spies } = makeDeps();
    await transferEntriesInto('move', ['/r/A', '/r/A/B'], '/r', deps);
    expect(spies.fs.move).not.toHaveBeenCalled();
  });
});

describe('removeItems — 嵌套选择', () => {
  it('trash [A, A/B] → 只删 A,不对已随 A 删除的 A/B 报错', async () => {
    const trash = vi.fn(async () => OK);
    const fs = { trash, rename: vi.fn(), createFile: vi.fn(), createDir: vi.fn() };
    const r = await removeItems(['/r/A', '/r/A/B'], { fs } as never, {
      invalidateChildrenIds: vi.fn(),
    });
    expect(r).toEqual({ ok: true, removed: ['/r/A'] });
    expect(trash.mock.calls).toEqual([['/r/A']]);
  });

  // 删 A 失败时,被折叠的 A/B 也没删掉:调用方若遍历原始选择、按「不在 failures 里 = 成功」判定,
  // 会把 A/B 当成功 → 关其 editor tab + 剪除剪贴板。removed 只列实际删掉的路径,调用方据此清理。
  it('trash [A, A/B, x] 且删 A 失败 → removed 不含 A 与被折叠的 A/B', async () => {
    const trash = vi.fn(async (p: string): Promise<Result> =>
      p === '/r/A' ? { ok: false, code: 'FS_DENIED', message: 'no perm' } : OK,
    );
    const fs = { trash, rename: vi.fn(), createFile: vi.fn(), createDir: vi.fn() };
    const r = await removeItems(['/r/A', '/r/A/B', '/r/x'], { fs } as never, {
      invalidateChildrenIds: vi.fn(),
    });
    expect(r.ok).toBe(false);
    expect(r.removed).toEqual(['/r/x']);
    if (!r.ok) expect(r.failures.map((f) => f.path)).toEqual(['/r/A']);
  });
});

// FolderTree onTrash 走 trashItemsAndCleanup:删除 + 「路径已删除」清理(editor / 剪贴板 / 展开集合)一处完成。
describe('onTrash 删除后只对实际删除的路径做清理', () => {
  it('trash [A, A/B, x] 且删 A 失败 → 清理只收到 result.removed', async () => {
    const trash = vi.fn(async (p: string): Promise<Result> =>
      p === '/r/A' ? { ok: false, code: 'FS_DENIED', message: 'no perm' } : OK,
    );
    const fs = { trash, rename: vi.fn(), createFile: vi.fn(), createDir: vi.fn() };
    const cleanup = vi.fn();
    const r = await trashItemsAndCleanup(
      ['/r/A', '/r/A/B', '/r/x'],
      { fs } as never,
      { invalidateChildrenIds: vi.fn() },
      cleanup,
    );
    expect(r.removed).toEqual(['/r/x']);
    expect(cleanup.mock.calls).toEqual([[['/r/x']]]);
  });

  // perf:批量删除后 editor tab 清理一次批量完成(O(R·T)+R 次 set → O(T·depth)+1 次 set)。
  it('perf · 多项删除成功 → 清理只调一次,收到全部 result.removed', async () => {
    const trash = vi.fn(async (): Promise<Result> => OK);
    const fs = { trash, rename: vi.fn(), createFile: vi.fn(), createDir: vi.fn() };
    const cleanup = vi.fn();
    const r = await trashItemsAndCleanup(
      ['/r/a', '/r/b', '/r/c'],
      { fs } as never,
      { invalidateChildrenIds: vi.fn() },
      cleanup,
    );
    expect(r.removed).toEqual(['/r/a', '/r/b', '/r/c']);
    expect(cleanup.mock.calls).toEqual([[['/r/a', '/r/b', '/r/c']]]);
  });

  it('全部失败 → 不清理', async () => {
    const trash = vi.fn(async (): Promise<Result> => ({
      ok: false,
      code: 'FS_DENIED',
      message: 'no perm',
    }));
    const fs = { trash, rename: vi.fn(), createFile: vi.fn(), createDir: vi.fn() };
    const cleanup = vi.fn();
    const r = await trashItemsAndCleanup(
      ['/r/A', '/r/A/B'],
      { fs } as never,
      { invalidateChildrenIds: vi.fn() },
      cleanup,
    );
    expect(r.ok).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('接线:root-drop 不在漏斗外预先剔掉 root 下的祖先', () => {
  it('root-drop 把全部拖动路径交给漏斗,由漏斗先剔后代再跳过同父项', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'panels', 'Explorer', 'FolderTree.tsx'),
      'utf-8',
    );
    // 旧实现把 selectRootDropMoveablePaths 的结果(已剔掉 root 下的 A)直接交给漏斗 → 只剩 A/B
    // 被移到 root,层级被拆散。
    expect(src).not.toMatch(/runBatchTransfer\('move', moveable,/);
    expect(src).toMatch(
      /runBatchTransfer\(\s*'move',\s*selectDraggedItemPaths\(dnd\.draggedItems\),\s*root,/,
    );
  });
});
