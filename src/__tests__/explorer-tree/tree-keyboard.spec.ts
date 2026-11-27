// @vitest-environment jsdom
// 文件树键盘操作的纯逻辑(tree-keyboard.ts):键位匹配(平台感知)与键入跳转查找。
import { describe, expect, it, vi } from 'vitest';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import {
  findTypeAheadIndex,
  focusFallbackIndex,
  handleTreeKeyDown,
  matchTreeKeyCommand,
  pageFocusTarget,
  type PageView,
  type TreeKeyContext,
} from '../../panels/Explorer/tree-keyboard';

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe('matchTreeKeyCommand', () => {
  it('Enter → open;带修饰键的 Enter 不算', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Enter' }), 'mac')).toBe('open');
    expect(matchTreeKeyCommand(ev({ key: 'Enter', metaKey: true }), 'mac')).toBeNull();
  });

  it('Delete 两平台都删;⌘⌫ 只在 mac 删;裸 Backspace 不删', () => {
    expect(matchTreeKeyCommand(ev({ key: 'Delete' }), 'other')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Delete' }), 'mac')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Backspace', metaKey: true }), 'mac')).toBe('trash');
    expect(matchTreeKeyCommand(ev({ key: 'Backspace', metaKey: true }), 'other')).toBeNull();
    expect(matchTreeKeyCommand(ev({ key: 'Backspace' }), 'mac')).toBeNull();
  });

  it('mod 键按平台:mac ⌘C / 其它 Ctrl+C;mac 上 Ctrl+C 不算复制', () => {
    expect(matchTreeKeyCommand(ev({ key: 'c', metaKey: true }), 'mac')).toBe('copy');
    expect(matchTreeKeyCommand(ev({ key: 'c', ctrlKey: true }), 'mac')).toBeNull();
    expect(matchTreeKeyCommand(ev({ key: 'c', ctrlKey: true }), 'other')).toBe('copy');
    expect(matchTreeKeyCommand(ev({ key: 'x', ctrlKey: true }), 'other')).toBe('cut');
    expect(matchTreeKeyCommand(ev({ key: 'v', ctrlKey: true }), 'other')).toBe('paste');
    expect(matchTreeKeyCommand(ev({ key: 'v', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});

describe('findTypeAheadIndex', () => {
  const names = ['alpha', 'Beta.ts', 'bravo.ts', 'charlie.ts'];

  it('单字母从下一项开始找(不分大小写),到尾环绕', () => {
    expect(findTypeAheadIndex(names, 0, 'b')).toBe(1);
    expect(findTypeAheadIndex(names, 1, 'b')).toBe(2);
    expect(findTypeAheadIndex(names, 2, 'b')).toBe(1);
    expect(findTypeAheadIndex(names, 3, 'a')).toBe(0);
  });

  it('多字符前缀从当前项开始(当前项仍匹配则留在原地)', () => {
    expect(findTypeAheadIndex(names, 1, 'be')).toBe(1);
    expect(findTypeAheadIndex(names, 1, 'br')).toBe(2);
  });

  it('同一字母重复(bb)按单字母循环', () => {
    expect(findTypeAheadIndex(names, 1, 'bb')).toBe(2);
  });

  it('无匹配 / 空列表 / 空前缀 → -1', () => {
    expect(findTypeAheadIndex(names, 0, 'z')).toBe(-1);
    expect(findTypeAheadIndex([], 0, 'a')).toBe(-1);
    expect(findTypeAheadIndex(names, 0, '')).toBe(-1);
  });
});

describe('handleTreeKeyDown · 删除防误触', () => {
  const fakeItem = (id: string) =>
    ({
      getId: () => id,
      isFolder: () => false,
      getItemData: () => ({ path: id, name: id.split('/').pop()!, isDirectory: false }),
      setFocused: vi.fn(),
    }) as unknown as ItemInstance<FileEntry>;
  const makeCtx = (
    focused: ItemInstance<FileEntry>,
    items: ItemInstance<FileEntry>[],
    selectedItems: string[] = [focused.getId()],
  ) => {
    const tree = {
      isRenamingItem: () => false,
      getDataRef: () => ({ current: {} }),
      getFocusedItem: () => focused,
      getState: () => ({ selectedItems }),
      setSelectedItems: vi.fn(),
      updateDomFocus: vi.fn(),
    } as unknown as TreeInstance<FileEntry>;
    const actions = { onTrash: vi.fn(), onCopy: vi.fn(), onCut: vi.fn(), onPaste: vi.fn() };
    const ctx: TreeKeyContext = {
      tree,
      items,
      actions,
      openFile: vi.fn(),
      rootPath: '/work',
      platform: 'other',
      typeAhead: { query: '', at: 0 },
    };
    return { ctx, actions };
  };
  const keyEv = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

  it('焦点项不在渲染列表(如被过滤的隐藏文件)→ Delete / 复制 / 剪切 / 粘贴都不执行', () => {
    const hidden = fakeItem('/work/.env');
    const { ctx, actions } = makeCtx(hidden, [fakeItem('/work/a.ts')]);
    handleTreeKeyDown(keyEv({ key: 'Delete' }), ctx);
    handleTreeKeyDown(keyEv({ key: 'c', ctrlKey: true }), ctx);
    handleTreeKeyDown(keyEv({ key: 'x', ctrlKey: true }), ctx);
    handleTreeKeyDown(keyEv({ key: 'v', ctrlKey: true }), ctx);
    expect(actions.onTrash).not.toHaveBeenCalled();
    expect(actions.onCopy).not.toHaveBeenCalled();
    expect(actions.onCut).not.toHaveBeenCalled();
    expect(actions.onPaste).not.toHaveBeenCalled();
  });

  it('选中集合里有不在渲染列表的项(如刚隐藏的 .env)→ Delete / 复制 / 剪切只作用于可见的选中项', () => {
    const a = fakeItem('/work/a.ts');
    const b = fakeItem('/work/b.ts');
    const { ctx, actions } = makeCtx(a, [a, b], ['/work/.env', '/work/a.ts', '/work/b.ts']);
    handleTreeKeyDown(keyEv({ key: 'Delete' }), ctx);
    handleTreeKeyDown(keyEv({ key: 'c', ctrlKey: true }), ctx);
    handleTreeKeyDown(keyEv({ key: 'x', ctrlKey: true }), ctx);
    expect(actions.onTrash.mock.calls[0]![0]).toEqual(['/work/a.ts', '/work/b.ts']);
    expect(actions.onCopy.mock.calls[0]![0]).toEqual(['/work/a.ts', '/work/b.ts']);
    expect(actions.onCut.mock.calls[0]![0]).toEqual(['/work/a.ts', '/work/b.ts']);
  });

  it('按住 Delete 的自动重复(e.repeat)不再删;首次按下照常', () => {
    const a = fakeItem('/work/a.ts');
    const { ctx, actions } = makeCtx(a, [a, fakeItem('/work/b.ts')]);
    handleTreeKeyDown(keyEv({ key: 'Delete', repeat: true }), ctx);
    expect(actions.onTrash).not.toHaveBeenCalled();
    handleTreeKeyDown(keyEv({ key: 'Delete' }), ctx);
    expect(actions.onTrash).toHaveBeenCalledTimes(1);
    expect(actions.onTrash.mock.calls[0]![0]).toEqual(['/work/a.ts']);
  });

  it('确认前不移动焦点 / 选中:焦点落点只在 onTrash 的确认回调里执行', () => {
    const a = fakeItem('/work/a.ts');
    const b = fakeItem('/work/b.ts');
    const { ctx, actions } = makeCtx(a, [a, b]);
    handleTreeKeyDown(keyEv({ key: 'Delete' }), ctx);
    expect(b.setFocused).not.toHaveBeenCalled();
    const onConfirmed = actions.onTrash.mock.calls[0]![1] as () => void;
    onConfirmed();
    expect(b.setFocused).toHaveBeenCalled();
  });
});

// VSCode listWidget focusNextPage / focusPreviousPage。视图:20 行 × 22px,可视高度 110(恰好 5 行)。
describe('pageFocusTarget(PageDown / PageUp 落点)', () => {
  const view = (scrollTop: number, extra: Partial<PageView> = {}): PageView => ({
    sizes: Array.from({ length: 20 }, () => 22),
    scrollTop,
    viewportHeight: 110,
    isFocusable: () => true,
    ...extra,
  });

  it('PageDown:焦点不在可视区末行 → 先到末行(不滚);已在末行 → 向下滚一整页再到新一页的末行', () => {
    expect(pageFocusTarget(view(0), 0, 1)).toEqual({ index: 4, scrollTop: 0 });
    expect(pageFocusTarget(view(0), undefined, 1)).toEqual({ index: 4, scrollTop: 0 });
    expect(pageFocusTarget(view(0), 4, 1)).toEqual({ index: 9, scrollTop: 110 });
  });

  it('PageDown 到底:滚不动且焦点已在末行 → null;最后一页不足一页 → 滚到底并落在末项', () => {
    const bottom = 20 * 22 - 110;
    expect(pageFocusTarget(view(bottom), 19, 1)).toBeNull();
    expect(pageFocusTarget(view(bottom - 22), 18, 1)).toEqual({ index: 19, scrollTop: bottom });
  });

  it('PageUp:焦点不在首个完整可见行 → 先到它;已在 → 向上滚一页再到新一页的首行;到顶 → null', () => {
    expect(pageFocusTarget(view(220), 14, -1)).toEqual({ index: 10, scrollTop: 220 });
    expect(pageFocusTarget(view(220), 10, -1)).toEqual({ index: 5, scrollTop: 110 });
    // 半行可见(scrollTop 不是行高整数倍)→ 首个完整可见行
    expect(pageFocusTarget(view(230), 14, -1)).toEqual({ index: 11, scrollTop: 230 });
    expect(pageFocusTarget(view(0), 0, -1)).toBeNull();
  });

  it('焦点在可视区之外(滚轮滚走)→ 按当前可视区计算', () => {
    // 焦点在上方(第 0 行),可视区 [10, 15) → PageDown 到可视区末行
    expect(pageFocusTarget(view(220), 0, 1)).toEqual({ index: 14, scrollTop: 220 });
    // 焦点在下方(第 19 行),可视区 [0, 5) → PageDown 滚一页,落在新一页末行
    expect(pageFocusTarget(view(0), 19, 1)).toEqual({ index: 9, scrollTop: 110 });
  });

  it('落点是不可聚焦行(读取失败行)→ 就近找可聚焦行;空列表 → null', () => {
    expect(pageFocusTarget(view(0, { isFocusable: (i) => i !== 4 }), 0, 1)).toEqual({ index: 3, scrollTop: 0 });
    // 就近找到的正是焦点本身 → 继续翻页(不卡住)
    expect(pageFocusTarget(view(0, { isFocusable: (i) => i !== 4 }), 3, 1)).toEqual({ index: 9, scrollTop: 110 });
    expect(pageFocusTarget(view(220, { isFocusable: (i) => i !== 10 }), 14, -1)).toEqual({ index: 11, scrollTop: 220 });
    expect(pageFocusTarget({ sizes: [], scrollTop: 0, viewportHeight: 100, isFocusable: () => true }, undefined, 1)).toBeNull();
  });
});

describe('focusFallbackIndex(焦点项不再显示时的去处)', () => {
  const ids = ['/w/a', '/w/a/x.ts', '/w/b.ts', null, '/w/c.ts'];
  it('最近的显示中祖先目录优先', () => {
    expect(focusFallbackIndex(ids, '/w/a/deep/y.ts', 4, '/w')).toBe(0);
    expect(focusFallbackIndex(ids, '/w/a/gone.ts', 2, '/w')).toBe(0);
  });
  it('无祖先(在根下)→ 原下标处的行;越界取末行;不可聚焦行跳过(先向后再向前)', () => {
    expect(focusFallbackIndex(ids, '/w/gone.ts', 2, '/w')).toBe(2);
    expect(focusFallbackIndex(ids, '/w/gone.ts', 9, '/w')).toBe(4);
    expect(focusFallbackIndex(ids, '/w/gone.ts', 3, '/w')).toBe(4);
    expect(focusFallbackIndex(['/w/a', null], '/w/gone.ts', 1, '/w')).toBe(0);
  });
  it('无可聚焦行 → -1', () => {
    expect(focusFallbackIndex([null], '/w/gone.ts', 0, '/w')).toBe(-1);
  });
});
