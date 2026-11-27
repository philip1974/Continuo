// @vitest-environment jsdom
// BDD:资源管理器「在文件夹中查找…」—— 菜单位置 / 键位、「要包含的文件」的写法、打开搜索视图并聚焦查询框。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';

const h = vi.hoisted(() => ({ openOrFocusPanel: vi.fn() }));
vi.mock('@/shell/dock/dock-api-ref', async (orig) => ({
  ...(await orig<typeof import('@/shell/dock/dock-api-ref')>()),
  openOrFocusPanel: h.openOrFocusPanel,
}));

import { ContextMenu, type ContextMenuActions } from '@/panels/Explorer/ContextMenu';
import { handleTreeKeyDown, matchTreeKeyCommand, type TreeKeyContext } from '@/panels/Explorer/tree-keyboard';
import { escapeGlobPattern, findInFolders, searchIncludesForFolders } from '@/panels/Search/find-in-folder';
import { __resetSearchForTest, useSearchStore } from '@/panels/Search/search-store';
import { compileGlobList } from '../../../electron/shared/workspace-search';
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
/** 菜单内容按顺序:菜单项文字,分隔线记为 '—'。 */
const menuSequence = () =>
  Array.from(document.querySelectorAll('[role=menuitem], [role=separator]')).map((el) =>
    el.getAttribute('role') === 'separator' ? '—' : (el.querySelector('.wm-menu-item__content')?.textContent ?? ''),
  );

function openMenu(target: FileEntry | null, actions: ContextMenuActions, selected: string[] = [], hasClipboard = false) {
  const r = render(
    <ContextMenu
      target={target}
      selectedPaths={new Set(selected)}
      rootPath="/work"
      actions={actions}
      hasClipboard={hasClipboard}
      pluginItems={[]}
    >
      <div data-testid="trigger">row</div>
    </ContextMenu>,
  );
  fireEvent.contextMenu(r.getByTestId('trigger'));
}

beforeEach(() => {
  setLocale('en');
  __resetSearchForTest();
  h.openOrFocusPanel.mockClear();
});
afterEach(() => cleanup());

describe('「要包含的文件」的写法(VSCode resolveResourcesForSearchIncludes)', () => {
  it('相对根、正斜杠、前缀 ./;多个去重保序', () => {
    expect(searchIncludesForFolders('/work', ['/work/src/a', '/work/docs', '/work/src/a'])).toEqual(['./src/a', './docs']);
  });

  it('根自身略过(不限范围);工作区外的略过', () => {
    expect(searchIncludesForFolders('/work', ['/work'])).toEqual([]);
    expect(searchIncludesForFolders('/work', ['/work', '/work/src'])).toEqual(['./src']);
    expect(searchIncludesForFolders('/work', ['/other/x'])).toEqual([]);
  });

  it('glob 元字符按字面([?*[]] 包进字符类),搜索的 glob 匹配器把它当字面路径', () => {
    expect(escapeGlobPattern('./a[1]/b*')).toBe('./a[[]1[]]/b[*]');
    const [pattern] = searchIncludesForFolders('/work', ['/work/a[1]']);
    const match = compileGlobList(pattern!)!;
    expect(match('a[1]/x.ts')).toBe(true);
    expect(match('a1/x.ts')).toBe(false);
  });
});

describe('findInFolders:打开搜索视图', () => {
  it('填入「要包含的文件」、展开详细信息、请求聚焦查询框、打开 / 激活搜索面板', () => {
    const before = useSearchStore.getState().focusRequest;
    findInFolders('/work', ['/work/src', '/work/docs']);
    const s = useSearchStore.getState();
    expect(s.include).toBe('./src, ./docs');
    expect(s.detailsOpen).toBe(true);
    expect(s.focusRequest).toBe(before + 1);
    expect(h.openOrFocusPanel).toHaveBeenCalledWith('search', 'search', 'Search', 'panels.search.title', { direction: 'left' }, 280);
  });

  it('只有根 → 清空「要包含的文件」,不展开详细信息', () => {
    useSearchStore.getState().setInclude('*.md');
    findInFolders('/work', ['/work']);
    expect(useSearchStore.getState().include).toBe('');
    expect(useSearchStore.getState().detailsOpen).toBe(false);
    expect(h.openOrFocusPanel).toHaveBeenCalled();
  });
});

describe('右键菜单位置(VSCode 4_search:紧随新建组,单独一组)', () => {
  it('文件夹:新建文件 / 新建文件夹 —「Find in Folder…」(⌥⇧F)— 剪切…', () => {
    openMenu(dir('/work/src'), makeActions(), ['/work/src']);
    const seq = menuSequence();
    expect(seq.slice(0, 6)).toEqual(['New File', 'New Folder', '—', 'Find in Folder…', '—', 'Cut']);
    const item = screen.getByRole('menuitem', { name: /Find in Folder/ });
    expect(item.querySelector('.wm-menu-item__shortcut')?.textContent).toMatch(/^(⌥⇧F|Alt\+Shift\+F)$/);
  });

  it('空白处:新建 —「Find in Folder…」(以根)', () => {
    const actions = makeActions();
    openMenu(null, actions);
    expect(menuSequence()).toEqual(['New File', 'New Folder', '—', 'Find in Folder…']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Find in Folder/ }));
    expect(actions.onFindInFolder).toHaveBeenCalledWith(['/work']);
  });

  it('多选:作用于整个选中集;文件菜单没有该项', () => {
    const actions = makeActions();
    openMenu(dir('/work/src'), actions, ['/work/src', '/work/docs']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Find in Folder/ }));
    expect(actions.onFindInFolder).toHaveBeenCalledWith(['/work/src', '/work/docs']);
    cleanup();
    openMenu(file('/work/a.ts'), makeActions(), ['/work/a.ts']);
    expect(screen.queryByRole('menuitem', { name: /Find in Folder/ })).toBeNull();
  });
});

describe('树内 ⇧⌥F', () => {
  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

  it('按物理键匹配(mac ⌥⇧F 产生的字符是 Ï)', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true }), 'mac')).toBe('findInFolder');
    expect(matchTreeKeyCommand(ev({ key: 'F', code: 'KeyF', shiftKey: true, altKey: true }), 'other')).toBe('findInFolder');
  });

  const fakeItem = (id: string, folder: boolean) =>
    ({
      getId: () => id,
      isFolder: () => folder,
      getItemData: () => ({ path: id, name: id.split('/').pop()!, isDirectory: folder }),
    }) as unknown as ItemInstance<FileEntry>;

  function ctxWith(focused: ItemInstance<FileEntry>, items: ItemInstance<FileEntry>[]) {
    const tree = {
      isRenamingItem: () => false,
      getDataRef: () => ({ current: {} }),
      getFocusedItem: () => focused,
      getState: () => ({ selectedItems: [focused.getId()] }),
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

  it('焦点项是文件夹 → 以它调用并消费;是文件 → 不处理(按键照常交给别处)', () => {
    const src = fakeItem('/work/src', true);
    const a = fakeItem('/work/a.ts', false);
    const onFolder = ctxWith(src, [src, a]);
    const e1 = new KeyboardEvent('keydown', { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true, cancelable: true });
    expect(handleTreeKeyDown(e1, onFolder.ctx)).toBe(true);
    expect(onFolder.actions.onFindInFolder).toHaveBeenCalledWith(['/work/src']);

    const onFile = ctxWith(a, [src, a]);
    const e2 = new KeyboardEvent('keydown', { key: 'Ï', code: 'KeyF', shiftKey: true, altKey: true, cancelable: true });
    expect(handleTreeKeyDown(e2, onFile.ctx)).toBe(false);
    expect(e2.defaultPrevented).toBe(false);
    expect(onFile.actions.onFindInFolder).not.toHaveBeenCalled();
  });
});
