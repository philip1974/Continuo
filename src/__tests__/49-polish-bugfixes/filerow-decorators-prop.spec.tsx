// @vitest-environment jsdom
// 打磨 R7(codex 性能):explorerDecorators 订阅从每个 FileRow 上提到 FolderTree
// 一次,装饰器快照作为 prop 下传。本测试守护「decorators prop → 本行装饰(badge/
// icon/textColor)正确合成渲染」,确保上提订阅后端到端行为不变。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ItemInstance } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import type { DecoratorFn } from '../../plugins/registries/ExplorerDecoratorRegistry';

// ContextMenu(radix)对本测试无关,透传 children 聚焦 decoration 渲染。
vi.mock('../../panels/Explorer/ContextMenu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: (_k: string, fallback: unknown) => fallback,
}));

import { FileRow } from '../../panels/Explorer/FileRow';

function mockItem(path: string, name: string): ItemInstance<FileEntry> {
  return {
    getItemData: () => ({ path, name, isDirectory: false }) as FileEntry,
    isFolder: () => false,
    isSelected: () => false,
    isFocused: () => false,
    isExpanded: () => false,
    isLoading: () => false,
    isRenaming: () => false,
    isDraggingOver: () => false,
    getItemMeta: () => ({ level: 0 }) as ReturnType<ItemInstance<FileEntry>['getItemMeta']>,
    getProps: () => ({}),
    getRenameInputProps: () => ({}),
  } as unknown as ItemInstance<FileEntry>;
}

function renderRow(decorators: readonly DecoratorFn[]) {
  return render(
    <FileRow
      item={mockItem('/work/a.ts', 'a.ts')}
      style={{}}
      selectedPaths={new Set()}
      rootPath="/work"
      contextActions={{} as never}
      decorators={decorators}
      hasClipboard={false}
      pluginMenuItems={[]}
      indent={16}
    />,
  );
}

afterEach(() => cleanup());

describe('打磨 R7 — FileRow 用下传的 decorators prop 合成装饰', () => {
  it('badge 装饰器 → 渲染 badge', () => {
    const deco: DecoratorFn = () => ({ badge: '3' });
    const { container } = renderRow([deco]);
    expect(container.querySelector('[aria-label="badge 3"]')).not.toBeNull();
    expect(container.textContent).toContain('3');
  });

  it('空 decorators → 不渲染 badge', () => {
    const { container } = renderRow([]);
    expect(container.querySelector('[aria-label^="badge"]')).toBeNull();
  });

  it('decorator 返 null → 无装饰', () => {
    const deco: DecoratorFn = () => null;
    const { container } = renderRow([deco]);
    expect(container.querySelector('[aria-label^="badge"]')).toBeNull();
  });
});
