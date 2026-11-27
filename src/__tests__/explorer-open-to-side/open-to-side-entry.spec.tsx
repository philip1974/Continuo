// @vitest-environment jsdom
// BDD:「在侧边打开」的入口 —— 文件右键菜单首项(⌃↵)、树内 ⌃Enter / Ctrl+Enter、⌥ 单击文件行。见同目录 README「行为 1」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import { ContextMenu, type ContextMenuActions } from '@/panels/Explorer/ContextMenu';
import { handleTreeKeyDown, matchTreeKeyCommand, type TreeKeyContext } from '@/panels/Explorer/tree-keyboard';
import type { FileEntry } from '@/lib/fs/types';
import { setLocale } from '@/i18n';

function makeActions(): ContextMenuActions {
  return {
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
    onOpenToSide: vi.fn(),
    onFindInFolder: vi.fn(),
  };
}

const file = (path: string) => ({ path, name: path.split('/').pop()!, isDirectory: false }) as FileEntry;
const dir = (path: string) => ({ path, name: path.split('/').pop()!, isDirectory: true }) as FileEntry;
const labels = () => Array.from(document.querySelectorAll('[role=menuitem]')).map((el) => el.textContent ?? '');

function openMenu(target: FileEntry | null, actions: ContextMenuActions, selected: string[] = []) {
  const r = render(
    <ContextMenu
      target={target}
      selectedPaths={new Set(selected)}
      rootPath="/work"
      actions={actions}
      hasClipboard={false}
      pluginItems={[]}
    >
      <div data-testid="trigger">row</div>
    </ContextMenu>,
  );
  fireEvent.contextMenu(r.getByTestId('trigger'));
}

beforeEach(() => setLocale('en'));
afterEach(() => cleanup());

describe('右键菜单', () => {
  it('文件菜单首项「Open to the Side」,右侧键位 ⌃↵(mac)/ Ctrl+Enter;其后是分隔线', () => {
    openMenu(file('/work/a.ts'), makeActions(), ['/work/a.ts']);
    const first = document.querySelector('[role=menuitem]')!;
    expect(first.textContent).toMatch(/^Open to the Side/);
    expect(first.querySelector('.wm-menu-item__shortcut')?.textContent).toMatch(/^(⌃↵|Ctrl\+Enter)$/);
    expect(first.nextElementSibling?.getAttribute('role')).toBe('separator');
  });

  it('选中 → 以该文件调用;右键的文件在多选集中 → 作用于整个选中集', () => {
    const actions = makeActions();
    openMenu(file('/work/a.ts'), actions, ['/work/a.ts', '/work/b.ts']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Open to the Side/ }));
    expect(actions.onOpenToSide).toHaveBeenCalledWith(['/work/a.ts', '/work/b.ts']);
  });

  it('选中后不把焦点还给触发行(焦点交给侧边组的编辑器,Radix 的延迟还原会把它抢回树里);「在文件夹中查找…」同', async () => {
    const actions = makeActions();
    for (const [target, name] of [
      [file('/work/a.ts'), /Open to the Side/],
      [dir('/work/src'), /Find in Folder/],
    ] as const) {
      const r = render(
        <ContextMenu target={target} selectedPaths={new Set()} rootPath="/work" actions={actions} hasClipboard={false} pluginItems={[]}>
          <div data-testid="trigger" tabIndex={0}>
            row
          </div>
        </ContextMenu>,
      );
      const trigger = r.getByTestId('trigger');
      trigger.focus();
      fireEvent.contextMenu(trigger);
      fireEvent.click(screen.getByRole('menuitem', { name }));
      await new Promise((res) => setTimeout(res, 20));
      expect(document.activeElement).not.toBe(trigger);
      r.unmount();
    }
    expect(actions.onOpenToSide).toHaveBeenCalledTimes(1);
    expect(actions.onFindInFolder).toHaveBeenCalledTimes(1);
  });

  it('文件夹与空白处菜单没有该项(VSCode when: !ExplorerFolderContext)', () => {
    openMenu(dir('/work/src'), makeActions(), ['/work/src']);
    expect(labels().some((l) => l.startsWith('Open to the Side'))).toBe(false);
    cleanup();
    openMenu(null, makeActions());
    expect(labels().some((l) => l.startsWith('Open to the Side'))).toBe(false);
  });
});

describe('树内键位', () => {
  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

  it('mac ⌃Enter / 其它 Ctrl+Enter → openToSide;mac ⌘Enter 不算', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), 'mac')).toBe('openToSide');
    expect(matchTreeKeyCommand(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), 'other')).toBe('openToSide');
    expect(matchTreeKeyCommand(ev({ key: 'Enter', code: 'Enter', metaKey: true }), 'mac')).toBeNull();
  });

  const fakeItem = (id: string, folder = false) =>
    ({
      getId: () => id,
      isFolder: () => folder,
      getItemData: () => ({ path: id, name: id.split('/').pop()!, isDirectory: folder }),
    }) as unknown as ItemInstance<FileEntry>;

  function ctxWith(focused: ItemInstance<FileEntry>, items: ItemInstance<FileEntry>[], selected: string[]) {
    const tree = {
      isRenamingItem: () => false,
      getDataRef: () => ({ current: {} }),
      getFocusedItem: () => focused,
      getState: () => ({ selectedItems: selected }),
    } as unknown as TreeInstance<FileEntry>;
    const actions = makeActions();
    const ctx: TreeKeyContext = {
      tree,
      items,
      actions,
      openFile: vi.fn(),
      rootPath: '/work',
      platform: 'mac',
      typeAhead: { query: '', at: 0 },
    };
    return { ctx, actions };
  }

  it('⌃Enter → 以焦点项(在多选集中则整个选中集)调用并消费按键', () => {
    const a = fakeItem('/work/a.ts');
    const b = fakeItem('/work/b.ts');
    const { ctx, actions } = ctxWith(a, [a, b], ['/work/a.ts', '/work/b.ts']);
    const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, cancelable: true });
    expect(handleTreeKeyDown(e, ctx)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(actions.onOpenToSide).toHaveBeenCalledWith(['/work/a.ts', '/work/b.ts']);
  });
});
