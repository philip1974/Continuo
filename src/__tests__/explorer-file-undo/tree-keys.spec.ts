// @vitest-environment jsdom
// BDD:撤销 / 重做文件操作的树内键位(README 规则 10)与命令(规则 11)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeInstance } from '@headless-tree/core';
import type { FileEntry } from '@/lib/fs/types';
import { handleTreeKeyDown, matchTreeKeyCommand, type TreeKeyContext } from '../../panels/Explorer/tree-keyboard';
import { explorerCommandSpecs } from '../../panels/Explorer/explorer-commands';
import { onExplorerRequest, __resetExplorerRequestsForTest, type ExplorerRequest } from '../../panels/Explorer/explorer-requests';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

describe('键位', () => {
  it('mac:⌘Z 撤销,⌘⇧Z 重做;Ctrl+Z / Ctrl+Y 不算', () => {
    expect(matchTreeKeyCommand(ev({ key: 'z', metaKey: true }), 'mac')).toBe('undo');
    expect(matchTreeKeyCommand(ev({ key: 'z', metaKey: true, shiftKey: true }), 'mac')).toBe('redo');
    expect(matchTreeKeyCommand(ev({ key: 'z', ctrlKey: true }), 'mac')).toBeNull();
    expect(matchTreeKeyCommand(ev({ key: 'y', metaKey: true }), 'mac')).toBeNull();
  });

  it('Win / Linux:Ctrl+Z 撤销,Ctrl+Y 与 Ctrl+Shift+Z 重做', () => {
    expect(matchTreeKeyCommand(ev({ key: 'z', ctrlKey: true }), 'other')).toBe('undo');
    expect(matchTreeKeyCommand(ev({ key: 'y', ctrlKey: true }), 'other')).toBe('redo');
    expect(matchTreeKeyCommand(ev({ key: 'z', ctrlKey: true, shiftKey: true }), 'other')).toBe('redo');
  });

  function ctx(over: Partial<TreeKeyContext> = {}): TreeKeyContext {
    const tree = {
      isRenamingItem: () => false,
      getFocusedItem: () => undefined,
      getDataRef: () => ({ current: {} }),
      getState: () => ({ selectedItems: [] }),
    } as unknown as TreeInstance<FileEntry>;
    return {
      tree,
      items: [],
      actions: { onTrash: vi.fn(), onCopy: vi.fn(), onCut: vi.fn(), onPaste: vi.fn() },
      openFile: vi.fn(),
      rootPath: '/ws',
      platform: 'mac',
      typeAhead: { query: '', at: 0 },
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      ...over,
    };
  }
  const keyEvent = (init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', init);
    if (init.target) Object.defineProperty(e, 'target', { value: init.target });
    return e;
  };

  it('树里(无焦点项也行)⌘Z / ⌘⇧Z 调撤销 / 重做并消费按键', () => {
    const c = ctx();
    const e = keyEvent({ key: 'z', metaKey: true, cancelable: true });
    expect(handleTreeKeyDown(e, c)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(c.onUndo).toHaveBeenCalledTimes(1);
    expect(handleTreeKeyDown(keyEvent({ key: 'z', metaKey: true, shiftKey: true }), c)).toBe(true);
    expect(c.onRedo).toHaveBeenCalledTimes(1);
  });

  it('输入框(改名 / 新建)里的 ⌘Z 不处理,留给原生撤销', () => {
    const c = ctx();
    const input = document.createElement('input');
    expect(handleTreeKeyDown(keyEvent({ key: 'z', metaKey: true, target: input }), c)).toBe(false);
    expect(c.onUndo).not.toHaveBeenCalled();
  });
});

describe('命令', () => {
  let requests: ExplorerRequest[];
  beforeEach(() => {
    __resetExplorerRequestsForTest();
    requests = [];
  });

  it('explorer.undo / explorer.redo:有工作区 → 打开侧栏并请求文件树;三语标题齐全', () => {
    const off = onExplorerRequest((r) => {
      requests.push(r);
      return true;
    });
    useWorkspaceStore.setState({ root: '/ws' });
    useLayoutUiStore.getState().setSidebarOpen(false);
    const specs = explorerCommandSpecs();
    for (const [id, kind] of [
      ['explorer.undo', 'undo'],
      ['explorer.redo', 'redo'],
    ] as const) {
      const spec = specs.find((s) => s.id === id)!;
      expect(spec.hotkey).toBeUndefined();
      void spec.fn();
      expect(requests.at(-1)).toEqual({ kind });
      const key = spec.titleKey as keyof typeof en;
      expect(en[key] && zh[key] && ko[key]).toBeTruthy();
    }
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    off();
  });

  it('无工作区 → 不发请求', () => {
    const off = onExplorerRequest((r) => {
      requests.push(r);
      return true;
    });
    useWorkspaceStore.setState({ root: null });
    void explorerCommandSpecs().find((s) => s.id === 'explorer.undo')!.fn();
    expect(requests).toEqual([]);
    off();
  });
});
