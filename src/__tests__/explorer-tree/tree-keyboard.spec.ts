// @vitest-environment jsdom
// 文件树键盘操作的纯逻辑(tree-keyboard.ts):键位匹配(平台感知)与键入跳转查找。
import { describe, expect, it, vi } from 'vitest';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';
import {
  findTypeAheadIndex,
  handleTreeKeyDown,
  matchTreeKeyCommand,
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
