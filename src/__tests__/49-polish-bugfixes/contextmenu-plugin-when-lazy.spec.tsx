// @vitest-environment jsdom
// 打磨 R13(codex 性能):插件右键菜单项的 when 谓词延迟到菜单真正打开时才跑。
// 虚拟列表每个可见 FileRow 都挂一个 ContextMenu,常规滚动/hover/重渲染本不需要
// 评估第三方 when();只有用户真正弹出菜单时才按当前上下文计算。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContextMenu,
  getContextActionTargets,
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
  it('多选 action targets 单趟拷贝 selectedPaths,不通过 Array.from', () => {
    const selectedPaths = new Set(['/work/a.ts', '/work/b.ts']);
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      expect(getContextActionTargets(target, selectedPaths)).toEqual(['/work/a.ts', '/work/b.ts']);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('多选 action targets 预分配数组,不通过 push 扩容', () => {
    const selectedPaths = new Set(['/work/a.ts', '/work/b.ts']);

    expect(getContextActionTargets(target, selectedPaths)).toEqual(['/work/a.ts', '/work/b.ts']);
    expect(getContextActionTargets.toString()).not.toContain('.push(');
  });

  it('空白右键 action targets 复用稳定空数组', () => {
    const selectedPaths = new Set(['/work/a.ts']);

    expect(getContextActionTargets(null, selectedPaths)).toBe(
      getContextActionTargets(null, selectedPaths),
    );
  });

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

  it('插件菜单多组分桶预分配,不通过 push 扩容', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'late-a', label: 'Late A', group: 'z', fn: vi.fn() },
      { id: 'early', label: 'Early', group: 'navigation', fn: vi.fn() },
      { id: 'late-b', label: 'Late B', group: 'z', fn: vi.fn() },
    ];

    const buckets = groupPluginItems(items, {
      target,
      selectedPaths: new Set(['/work/a.ts']),
      rootPath: '/work',
    });

    expect(buckets.map((bucket) => bucket.group)).toEqual(['navigation', 'z']);
    expect(buckets[0]?.items).toEqual([items[1]]);
    expect(buckets[1]?.items).toEqual([items[0], items[2]]);
    expect(groupPluginItems.toString()).not.toContain('.push(');
  });

  it('插件菜单多组已按渲染顺序时不调用 sort', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'new-a', label: 'New A', group: 'new', fn: vi.fn() },
      { id: 'plugin-a', label: 'Plugin A', group: 'plugin', fn: vi.fn() },
      { id: 'custom-a', label: 'Custom A', group: 'z', fn: vi.fn() },
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const buckets = groupPluginItems(items, {
        target,
        selectedPaths: new Set(['/work/a.ts']),
        rootPath: '/work',
      });

      expect(sortSpy).not.toHaveBeenCalled();
      expect(buckets.map((bucket) => bucket.group)).toEqual(['new', 'plugin', 'z']);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('无可见插件项分组复用稳定空桶', () => {
    const hidden: ExplorerContextMenuItemSpec = {
      id: 'hidden',
      label: 'Hidden',
      when: () => false,
      fn: vi.fn(),
    };

    expect(
      groupPluginItems([hidden], {
        target,
        selectedPaths: new Set(['/work/a.ts']),
        rootPath: '/work',
      }),
    ).toBe(
      groupPluginItems([hidden], {
        target,
        selectedPaths: new Set(['/work/a.ts']),
        rootPath: '/work',
      }),
    );
  });

  it('单个可见插件项分组走快路径,不构造 Map 且不排序', () => {
    const item: ExplorerContextMenuItemSpec = {
      id: 'only',
      label: 'Only',
      group: 'navigation',
      fn: vi.fn(),
    };
    const mapGetSpy = vi.spyOn(Map.prototype, 'get');
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const buckets = groupPluginItems([item], {
        target,
        selectedPaths: new Set(['/work/a.ts']),
        rootPath: '/work',
      });
      expect(mapGetSpy).not.toHaveBeenCalled();
      expect(sortSpy).not.toHaveBeenCalled();
      expect(buckets).toEqual([{ group: 'navigation', items: [item] }]);
    } finally {
      mapGetSpy.mockRestore();
      sortSpy.mockRestore();
    }
  });

  it('同一 group 的多条插件项复用输入 items,不构造 Map 且不排序', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'a', label: 'A', group: 'plugin', fn: vi.fn() },
      { id: 'b', label: 'B', group: 'plugin', fn: vi.fn() },
    ];
    const mapGetSpy = vi.spyOn(Map.prototype, 'get');
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const buckets = groupPluginItems(items, {
        target,
        selectedPaths: new Set(['/work/a.ts']),
        rootPath: '/work',
      });

      expect(buckets).toEqual([{ group: 'plugin', items }]);
      expect(buckets[0]?.items).toBe(items);
      expect(mapGetSpy).not.toHaveBeenCalled();
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      mapGetSpy.mockRestore();
      sortSpy.mockRestore();
    }
  });

  it('菜单未打开 → 不评估插件 when', () => {
    const when = vi.fn(() => true);
    renderMenu([{ id: 'p1', label: 'Plugin Item', when, fn: vi.fn() }]);
    expect(when).not.toHaveBeenCalled();
  });

  it('菜单未打开 → 不计算 action targets', () => {
    const has = vi.fn(() => true);
    const size = vi.fn(() => 1);
    const selectedPaths = {
      has,
      [Symbol.iterator]: function* () {
        yield '/work/a.ts';
      },
    } as unknown as ReadonlySet<string>;
    Object.defineProperty(selectedPaths, 'size', {
      configurable: true,
      get: size,
    });

    render(
      <ContextMenu
        target={target}
        selectedPaths={selectedPaths}
        rootPath="/work"
        actions={noopActions}
        hasClipboard={false}
        pluginItems={[]}
      >
        <div data-testid="trigger">row</div>
      </ContextMenu>,
    );

    expect(has).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
  });

  it('菜单未打开 → 不构建 Menu.Content 子树', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Explorer/ContextMenu.tsx'), 'utf-8');

    expect(src).toMatch(/\{open && \(\s*<ContextMenuContent/);
    expect(src).toMatch(/function ContextMenuContent\([\s\S]*<Menu\.Portal>/);
  });

  it('菜单未打开 → ContextMenu 外壳不订阅 i18n', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Explorer/ContextMenu.tsx'), 'utf-8');
    const shellStart = src.indexOf('export function ContextMenu({');
    const contentStart = src.indexOf('function ContextMenuContent({');
    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(contentStart).toBeGreaterThan(shellStart);

    expect(src.slice(shellStart, contentStart)).not.toContain('useT()');
    expect(src.slice(contentStart)).toContain('useT()');
  });

  it('右键打开菜单 → 评估 when 且可见项渲染', () => {
    const when = vi.fn(() => true);
    const { getByTestId } = renderMenu([{ id: 'p1', label: 'Plugin Item', when, fn: vi.fn() }]);
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
