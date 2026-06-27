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
import { coApp } from '../../plugins/co-app';

// race(R57):FileRow 合并装饰时读 live coApp.explorerDecorators.getAll()(防快照滞后期执行已
// unregister 的 decorator)。故测试在真源注册 decorator(prop 仍作 memo 失效键传入),afterEach
// 清理避免跨测试泄漏(否则一测试注册的 decorator 会在另一测试的 FileRow 里渲染)。
let decoratorDisposers: Array<() => void> = [];
function registerDecorators(decorators: readonly DecoratorFn[]): void {
  decoratorDisposers = decorators.map(
    (fn) => coApp.explorerDecorators.register(fn).dispose,
  );
}

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
  registerDecorators(decorators); // R57:在真源注册供 FileRow 的 live getAll() 读到
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

afterEach(() => {
  decoratorDisposers.forEach((d) => d());
  decoratorDisposers = [];
  cleanup();
});

describe('打磨 R7 — FileRow 用下传的 decorators prop 合成装饰', () => {
  // a11y(A109):badge 不再用硬编码英文 aria-label,可见文本自然朗读;用 .tabular-nums 定位 badge span。
  it('badge 装饰器 → 渲染 badge(可见文本,无英文 aria-label)', () => {
    const deco: DecoratorFn = () => ({ badge: '3' });
    const { container } = renderRow([deco]);
    const badge = container.querySelector('span.tabular-nums');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('3');
    // 不再有硬编码英文 "badge" aria-label
    expect(container.querySelector('[aria-label^="badge"]')).toBeNull();
  });

  it('空 decorators → 不渲染 badge', () => {
    const { container } = renderRow([]);
    expect(container.querySelector('span.tabular-nums')).toBeNull();
  });

  it('decorator 返 null → 无装饰', () => {
    const deco: DecoratorFn = () => null;
    const { container } = renderRow([deco]);
    expect(container.querySelector('span.tabular-nums')).toBeNull();
  });
});

// a11y(A110):目录行加载态须 aria-busy(根)+ … aria-hidden + 视觉隐藏「加载中」文本。
describe('a11y(A110) — 目录行加载态可被 AT 感知', () => {
  function loadingItem(): ItemInstance<FileEntry> {
    return {
      getItemData: () =>
        ({ path: '/work/dir', name: 'dir', isDirectory: true }) as FileEntry,
      isFolder: () => true,
      isSelected: () => false,
      isFocused: () => false,
      isExpanded: () => true,
      isLoading: () => true,
      isRenaming: () => false,
      isDraggingOver: () => false,
      getItemMeta: () =>
        ({ level: 0 }) as ReturnType<ItemInstance<FileEntry>['getItemMeta']>,
      getProps: () => ({}),
      getRenameInputProps: () => ({}),
    } as unknown as ItemInstance<FileEntry>;
  }

  it('isLoading → 行根 aria-busy + … aria-hidden + 加载文本可读', () => {
    const { container } = render(
      <FileRow
        item={loadingItem()}
        style={{}}
        selectedPaths={new Set()}
        rootPath="/work"
        contextActions={{} as never}
        decorators={[]}
        hasClipboard={false}
        pluginMenuItems={[]}
        indent={16}
      />,
    );
    // 行根 aria-busy=true
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // … 在 aria-hidden span
    const ellipsis = Array.from(container.querySelectorAll('span[aria-hidden="true"]')).find(
      (s) => (s.textContent ?? '').includes('…'),
    );
    expect(ellipsis).toBeTruthy();
    // 加载文本(zh 默认「加载中」)在 DOM 可被 AT 读
    expect(container.textContent).toContain('加载中');
  });
});

// a11y(A71,A70 同族装饰符号):目录行展开箭头 ▾/▸ 是纯视觉状态(展开态由 headless-tree
// row props 的 aria-expanded 表达),须 aria-hidden,否则混进行可访问名造成三角噪声。
describe('a11y(A71) — 目录行展开箭头 aria-hidden', () => {
  function dirItem(expanded: boolean): ItemInstance<FileEntry> {
    return {
      getItemData: () =>
        ({ path: '/work/dir', name: 'dir', isDirectory: true }) as FileEntry,
      isFolder: () => true,
      isSelected: () => false,
      isFocused: () => false,
      isExpanded: () => expanded,
      isLoading: () => false,
      isRenaming: () => false,
      isDraggingOver: () => false,
      getItemMeta: () =>
        ({ level: 0 }) as ReturnType<ItemInstance<FileEntry>['getItemMeta']>,
      getProps: () => ({}),
      getRenameInputProps: () => ({}),
    } as unknown as ItemInstance<FileEntry>;
  }

  function renderDir(expanded: boolean) {
    return render(
      <FileRow
        item={dirItem(expanded)}
        style={{}}
        selectedPaths={new Set()}
        rootPath="/work"
        contextActions={{} as never}
        decorators={[]}
        hasClipboard={false}
        pluginMenuItems={[]}
        indent={16}
      />,
    );
  }

  it('折叠目录 ▸ 在 aria-hidden span 内', () => {
    const { container } = renderDir(false);
    const arrow = Array.from(container.querySelectorAll('span')).find((s) =>
      /[▾▸]/.test(s.textContent ?? ''),
    );
    expect(arrow).toBeTruthy();
    expect(arrow!.textContent).toContain('▸');
    expect(arrow!.getAttribute('aria-hidden')).toBe('true');
  });

  it('展开目录 ▾ 在 aria-hidden span 内', () => {
    const { container } = renderDir(true);
    const arrow = Array.from(container.querySelectorAll('span')).find((s) =>
      /[▾▸]/.test(s.textContent ?? ''),
    );
    expect(arrow!.textContent).toContain('▾');
    expect(arrow!.getAttribute('aria-hidden')).toBe('true');
  });
});

// a11y(A26,A5 同族):headless-tree getRenameInputProps() 不含 aria-label → 重命名编辑框无名。
// 调用点补 aria-label(含文件名)。locale-无关:断言 aria-label 含文件名。
describe('a11y(A26) — inline rename input 可访问名', () => {
  it('isRenaming 时 rename <input> 有含文件名的 aria-label', () => {
    const item = {
      getItemData: () => ({ path: '/work/a.ts', name: 'a.ts', isDirectory: false }),
      isFolder: () => false,
      isSelected: () => false,
      isFocused: () => false,
      isExpanded: () => false,
      isLoading: () => false,
      isRenaming: () => true, // 进入重命名 → 渲染 Input
      isDraggingOver: () => false,
      getItemMeta: () => ({ level: 0 }),
      getProps: () => ({}),
      getRenameInputProps: () => ({}), // 库不提供 aria-label
    } as unknown as ItemInstance<FileEntry>;
    const { container } = render(
      <FileRow
        item={item}
        style={{}}
        selectedPaths={new Set()}
        rootPath="/work"
        contextActions={{} as never}
        decorators={[]}
        hasClipboard={false}
        pluginMenuItems={[]}
        indent={16}
      />,
    );
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('aria-label') ?? '').toContain('a.ts');
  });
});
