// @vitest-environment jsdom
// 打磨 R13(codex 性能):插件右键菜单项的 when 谓词延迟到菜单真正打开时才跑。
// 虚拟列表每个可见 FileRow 都挂一个 ContextMenu,常规滚动/hover/重渲染本不需要
// 评估第三方 when();只有用户真正弹出菜单时才按当前上下文计算。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import {
  ContextMenu,
  groupPluginItems,
  type ContextMenuActions,
} from '../../panels/Explorer/ContextMenu';
import type { ExplorerContextMenuItemSpec } from '../../plugins/registries/ExplorerContextMenuRegistry';
import type { FileEntry } from '../../lib/fs/types';

const noopActions = {
  onRename: vi.fn(),
  onNewFile: vi.fn(),
  onNewDir: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyRelativePath: vi.fn(),
  onRevealInFinder: vi.fn(),
  onOpenInTerminal: vi.fn(),
  onTrash: vi.fn(),
  onCut: vi.fn(),
  onCopy: vi.fn(),
  onPaste: vi.fn(),
} satisfies ContextMenuActions;

const target: FileEntry = {
  path: '/work/a.ts',
  name: 'a.ts',
  isDirectory: false,
} as FileEntry;

function renderMenu(items: readonly ExplorerContextMenuItemSpec[]) {
  return render(
    <ContextMenu
      target={target}
      selectedPaths={new Set(['/work/a.ts'])}
      rootPath="/work"
      actions={noopActions}
      hasClipboard={false}
      pluginItems={items}
    >
      <div data-testid="trigger">row</div>
    </ContextMenu>,
  );
}

afterEach(() => cleanup());

describe('打磨 R13 — 插件菜单 when 延迟到打开', () => {
  it('插件菜单分组不通过 Array.from(entries).map 生成中间数组', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'late', label: 'Late', group: 'z', fn: vi.fn() },
      { id: 'early', label: 'Early', group: 'navigation', fn: vi.fn() },
    ];
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const buckets = groupPluginItems(items, {
        target,
        selectedPaths: ['/work/a.ts'],
        rootPath: '/work',
      });
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(buckets.map((bucket) => bucket.group)).toEqual(['navigation', 'z']);
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('菜单未打开 → 不评估插件 when', () => {
    const when = vi.fn(() => true);
    renderMenu([{ id: 'p1', label: 'Plugin Item', when, fn: vi.fn() }]);
    expect(when).not.toHaveBeenCalled();
  });

  it('右键打开菜单 → 评估 when 且可见项渲染', () => {
    const when = vi.fn(() => true);
    const { getByTestId } = renderMenu([
      { id: 'p1', label: 'Plugin Item', when, fn: vi.fn() },
    ]);
    fireEvent.contextMenu(getByTestId('trigger'));
    expect(when).toHaveBeenCalled();
    // Content 经 Portal 挂到 document.body
    expect(document.body.textContent).toContain('Plugin Item');
  });

  it('when 返 false → 打开后该项不渲染', () => {
    const { getByTestId } = renderMenu([
      { id: 'p1', label: 'Hidden Item', when: () => false, fn: vi.fn() },
    ]);
    fireEvent.contextMenu(getByTestId('trigger'));
    expect(document.body.textContent).not.toContain('Hidden Item');
  });
});
