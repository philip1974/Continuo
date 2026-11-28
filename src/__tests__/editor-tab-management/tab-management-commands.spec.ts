// @vitest-environment jsdom
// BDD:编辑器 tab / 组管理命令 —— 默认键、⌥⌘→ 跨组、按序号直达、移动、合并、⌘W 遇固定 tab、全部关闭、终端让出。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: { readFile: vi.fn(), writeFile: vi.fn(), onDirChanged: vi.fn(() => vi.fn()) },
    shell: { openExternal: vi.fn() },
    window: { close: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import {
  createTab,
  editorGroupIdsOf,
  groupStickyTabsOf,
  groupTabsOf,
  useEditorStore,
} from '../../stores/editor.store';
import {
  closeAllEditors,
  closeEditorGroup,
  editorCommandSpecs,
  openAdjacentEditor,
  openAdjacentEditorInGroup,
  openEditorAtIndex,
  registerEditorPanelActions,
  revealNextNonStickyEditor,
  type EditorPanelActions,
} from '../../panels/Editor/editor-commands';
import { joinEditorGroups, moveEditor } from '../../panels/Editor/editor-groups-actions';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import {
  isTerminalKeptHotkey,
  terminalYieldedCommandId,
} from '../../panels/Terminal/terminal-hotkeys';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const D = '/w/d.ts';

const st = () => useEditorStore.getState();

function reset(): void {
  setDockApi(null);
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    groupMru: ['editor'],
    tabMru: new Map(),
    previewTabs: new Map(),
    stickyTabs: new Map(),
    viewRefs: new Map(),
  });
}

function open(path: string, groupId?: string): void {
  st().openTab(createTab(path, path), groupId === undefined ? undefined : { groupId });
}

function ids(groupId: string): string[] {
  return groupTabsOf(st(), groupId).map((t) => t.id);
}

/** editor: A B;editor:2: C D(活动组 editor:2,活动 D)。 */
function twoGroups(): void {
  open(A);
  open(B);
  st().splitGroup('editor', 'editor:2', null);
  open(C);
  open(D);
}

function fakeActions(over: Partial<EditorPanelActions> = {}): EditorPanelActions {
  return {
    save: vi.fn(async () => {}),
    saveAs: vi.fn(async () => {}),
    closeActiveTab: vi.fn(() => false),
    closeTabs: vi.fn(),
    confirmCloseDocs: vi.fn(async () => true),
    saveTabForSaveAll: vi.fn(async () => false),
    confirmRevertLosingUndo: vi.fn(async () => true),
    ...over,
  };
}

function key(init: KeyboardEventInit & { key: string; code?: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

beforeEach(reset);

describe('命令注册与默认键(按平台对齐 VSCode)', () => {
  const byId = (platform: 'mac' | 'other') => new Map(editorCommandSpecs(platform).map((c) => [c.id, c]));

  it('移动编辑器:mac ⌃⌘← / ⌃⌘→ / ⌃⌘1 / ⌃⌘9,组内左右移无默认键(和弦);Win/Linux Ctrl+Alt+← / → / Shift+Alt+1 / 9 / Ctrl+Shift+PageUp / PageDown', () => {
    const mac = byId('mac');
    const other = byId('other');
    expect(mac.get('workbench.action.moveEditorToPreviousGroup')?.hotkey).toBe('ctrl+mod+left');
    expect(mac.get('workbench.action.moveEditorToNextGroup')?.hotkey).toBe('ctrl+mod+right');
    expect(mac.get('workbench.action.moveEditorToFirstGroup')?.hotkey).toBe('ctrl+mod+1');
    expect(mac.get('workbench.action.moveEditorToLastGroup')?.hotkey).toBe('ctrl+mod+9');
    expect(mac.get('workbench.action.moveEditorLeftInGroup')?.hotkey).toBeUndefined();
    expect(mac.get('workbench.action.moveEditorRightInGroup')?.hotkey).toBeUndefined();
    expect(other.get('workbench.action.moveEditorToPreviousGroup')?.hotkey).toBe('ctrl+alt+left');
    expect(other.get('workbench.action.moveEditorToNextGroup')?.hotkey).toBe('ctrl+alt+right');
    expect(other.get('workbench.action.moveEditorToFirstGroup')?.hotkey).toBe('shift+alt+1');
    expect(other.get('workbench.action.moveEditorToLastGroup')?.hotkey).toBe('shift+alt+9');
    expect(other.get('workbench.action.moveEditorLeftInGroup')?.hotkey).toBe('ctrl+shift+pageup');
    expect(other.get('workbench.action.moveEditorRightInGroup')?.hotkey).toBe('ctrl+shift+pagedown');
  });

  it('按序号打开:mac ⌃1…⌃9、Win/Linux Alt+1…Alt+9;最后一个 mac ⌃0(附加 ⌘9)、Win/Linux Alt+0', () => {
    for (let n = 1; n <= 9; n++) {
      expect(byId('mac').get(`workbench.action.openEditorAtIndex${n}`)?.hotkey).toBe(`ctrl+${n}`);
      expect(byId('other').get(`workbench.action.openEditorAtIndex${n}`)?.hotkey).toBe(`alt+${n}`);
    }
    expect(byId('mac').get('workbench.action.lastEditorInGroup')).toMatchObject({ hotkey: 'ctrl+0', secondaryHotkeys: ['mod+9'] });
    expect(byId('other').get('workbench.action.lastEditorInGroup')?.hotkey).toBe('alt+0');
  });

  it('聚焦第 1–8 个编辑器组 ⌘1…⌘8;固定 / 组内切换 / 全部关闭 / 合并无默认键(VSCode 为和弦或无键)', () => {
    const mac = byId('mac');
    const focus = [...mac.values()].filter((c) => /^workbench\.action\.focus\w+EditorGroup$/.test(c.id));
    expect(focus.map((c) => c.hotkey)).toEqual(['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8']);
    for (const id of [
      'workbench.action.pinEditor',
      'workbench.action.unpinEditor',
      'workbench.action.nextEditorInGroup',
      'workbench.action.previousEditorInGroup',
      'workbench.action.closeAllEditors',
      'workbench.action.closeAllGroups',
      'workbench.action.closeEditorsAndGroup',
      'workbench.action.joinTwoGroups',
      'workbench.action.joinAllGroups',
    ]) {
      expect(mac.get(id), id).toBeDefined();
      expect(mac.get(id)?.hotkey, id).toBeUndefined();
    }
  });

  it('新增默认键与既有绑定不冲突(注册进同一张表时没有被别的命令占用)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const specs = editorCommandSpecs(platform);
      const seen = new Map<string, string>();
      for (const c of specs) {
        for (const k of [c.hotkey, ...(c.secondaryHotkeys ?? [])]) {
          if (k === undefined) continue;
          expect(seen.get(k), `${platform} ${k}: ${c.id}`).toBeUndefined();
          seen.set(k, c.id);
        }
      }
    }
  });
});

describe('下一个 / 上一个编辑器跨组(⌥⌘→ / ⌥⌘←)', () => {
  it('到组尾 → 下一个组的第一个;最后一组的尾 → 第一组的第一个(首尾相接)', () => {
    twoGroups();
    openAdjacentEditor(1);
    expect(st().activeGroupId).toBe('editor');
    expect(st().activeTabId).toBe(A);
    openAdjacentEditor(1);
    expect(st().activeTabId).toBe(B);
    openAdjacentEditor(1);
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor:2', C]);
  });

  it('到组首 → 上一个组的最后一个;跳过空组', () => {
    twoGroups();
    st().splitGroup('editor:2', 'editor:3', null);
    st().switchTab(C, { groupId: 'editor:2' });
    openAdjacentEditor(-1);
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor', B]);
    openAdjacentEditor(-1);
    openAdjacentEditor(-1);
    // editor:3 为空 → 跳过,到 editor:2 的最后一个
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor:2', D]);
  });

  it('只有一个组 → 组内首尾相接(与此前一致);nextEditorInGroup 始终只在组内循环', () => {
    open(A);
    open(B);
    openAdjacentEditor(1);
    expect(st().activeTabId).toBe(A);
    st().splitGroup('editor', 'editor:2', null);
    open(C);
    open(D);
    openAdjacentEditorInGroup(1);
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor:2', C]);
  });
});

describe('按序号直达(⌃1…⌃9 / ⌃0)', () => {
  it('打开活动组第 N 个;9 = 第 9 个(不存在 → 不动);lastEditorInGroup = 最后一个', () => {
    for (const p of ['/w/1', '/w/2', '/w/3']) open(p);
    openEditorAtIndex(1);
    expect(st().activeTabId).toBe('/w/1');
    openEditorAtIndex(9);
    expect(st().activeTabId).toBe('/w/1');
    openEditorAtIndex(Infinity);
    expect(st().activeTabId).toBe('/w/3');
  });

  it('作用于活动组', () => {
    twoGroups();
    openEditorAtIndex(1);
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor:2', C]);
  });
});

describe('移动命令(moveEditor)', () => {
  it('移到上一组 / 第一组 / 最后一组;已是最后一组 → 不动', () => {
    twoGroups();
    expect(moveEditor('previous')).toBe(true);
    expect(ids('editor')).toEqual([A, B, D]);
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor', D]);
    expect(moveEditor('last')).toBe(true);
    expect(ids('editor:2')).toEqual([C, D]);
    expect(moveEditor('last')).toBe(false);
  });

  it('组内左移 / 右移一位,到头收住', () => {
    open(A);
    open(B);
    open(C);
    moveEditor('left');
    expect(ids('editor')).toEqual([A, C, B]);
    moveEditor('right');
    moveEditor('right');
    expect(ids('editor')).toEqual([A, B, C]);
  });
});

describe('合并组(joinTwoGroups / joinAllGroups)', () => {
  it('joinTwoGroups:活动组并入相邻组(先下一个,没有再上一个),原活动编辑器在目标组激活;固定的仍固定', () => {
    twoGroups();
    st().pinEditor(C, 'editor:2');
    joinEditorGroups(false);
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([C, A, B, D]);
    expect(groupStickyTabsOf(st(), 'editor')).toEqual([C]);
    expect(st().activeTabId).toBe(D);
  });

  it('joinAllGroups:其它组都并入活动组', () => {
    twoGroups();
    st().splitGroup('editor:2', 'editor:3', null);
    open('/w/e.ts');
    st().setActiveGroup('editor');
    joinEditorGroups(true);
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B, C, D, '/w/e.ts']);
    expect(st().activeTabId).toBe(B);
  });
});

describe('⌘W 遇固定的活动 tab(VSCode preventPinnedEditorClose 默认 keyboardAndMouse)', () => {
  it('不关闭,改打开组内最近使用的非固定编辑器(面板动作 closeActiveTab 判定,见 EditorPanel)', () => {
    open(A);
    open(B);
    open(C);
    st().switchTab(B);
    st().pinEditor(C);
    st().switchTab(C);
    revealNextNonStickyEditor('editor');
    expect(st().activeTabId).toBe(B);
    expect(ids('editor')).toEqual([C, A, B]);
  });

  it('组内都固定 → 去别的组找;都没有 → 不动', () => {
    twoGroups();
    st().pinEditor(C, 'editor:2');
    st().pinEditor(D, 'editor:2');
    revealNextNonStickyEditor('editor:2');
    expect(st().activeGroupId).toBe('editor');
    st().pinEditor(A, 'editor');
    st().pinEditor(B, 'editor');
    st().switchTab(B, { groupId: 'editor' });
    revealNextNonStickyEditor('editor');
    expect([st().activeGroupId, st().activeTabId]).toEqual(['editor', B]);
  });
});

describe('全部关闭 / 关闭编辑器组', () => {
  it('closeAllEditors:跨组的脏文档只确认一次;跳过固定的;确认后关闭,空组随之关闭', async () => {
    twoGroups();
    st().updateContent(B, 'x');
    st().updateContent(D, 'y');
    st().pinEditor(A, 'editor');
    const confirm = vi.fn(async (_ids: readonly string[]) => true);
    const off = registerEditorPanelActions(fakeActions({ confirmCloseDocs: confirm }), 'editor:2');
    await closeAllEditors(false);
    off();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect([...confirm.mock.calls[0]![0]].sort()).toEqual([B, C, D].sort());
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A]);
  });

  it('closeAllEditors 取消 → 都不关', async () => {
    twoGroups();
    st().updateContent(B, 'x');
    const off = registerEditorPanelActions(fakeActions({ confirmCloseDocs: vi.fn(async () => false) }), 'editor:2');
    await closeAllEditors(false);
    off();
    expect(ids('editor')).toEqual([A, B]);
    expect(ids('editor:2')).toEqual([C, D]);
  });

  it('closeAllGroups(含固定的):全部关闭,只剩一个空编辑区', async () => {
    twoGroups();
    st().pinEditor(A, 'editor');
    const off = registerEditorPanelActions(fakeActions(), 'editor:2');
    await closeAllEditors(true);
    off();
    expect(editorGroupIdsOf(st())).toHaveLength(1);
    expect(st().tabs).toEqual([]);
  });

  it('文档在某组固定 → 不算随之关闭的文档,不为它确认', async () => {
    twoGroups();
    open(B, 'editor:2');
    st().pinEditor(B, 'editor');
    st().updateContent(B, 'x');
    const confirm = vi.fn(async (_ids: readonly string[]) => true);
    const off = registerEditorPanelActions(fakeActions({ confirmCloseDocs: confirm }), 'editor:2');
    await closeAllEditors(false);
    off();
    expect(confirm.mock.calls[0]![0]).not.toContain(B);
    expect(ids('editor')).toEqual([B]);
  });

  it('关闭编辑器组(closeEditorsAndGroup):只为只在本组打开的文档确认;关闭组内全部(含固定),组随之关闭', async () => {
    twoGroups();
    open(A, 'editor:2');
    st().pinEditor(C, 'editor:2');
    const confirm = vi.fn(async (_ids: readonly string[]) => true);
    const off = registerEditorPanelActions(fakeActions({ confirmCloseDocs: confirm }), 'editor:2');
    await closeEditorGroup('editor:2');
    off();
    expect(confirm.mock.calls[0]![0]).toEqual([C, D]);
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B]);
  });

  it('关闭编辑器组取消 → 组不动', async () => {
    twoGroups();
    const off = registerEditorPanelActions(fakeActions({ confirmCloseDocs: vi.fn(async () => false) }), 'editor:2');
    await closeEditorGroup('editor:2');
    off();
    expect(ids('editor:2')).toEqual([C, D]);
  });
});

describe('终端获焦时(VSCode commandsToSkipShell)', () => {
  const registry = { getAll: () => editorCommandSpecs('mac') };

  it('⌃1(按序号打开)交给 shell;⌘9 / ⌃0(最后一个)、⌘4(聚焦第 4 组)让出', () => {
    const ctrl1 = key({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(terminalYieldedCommandId(ctrl1, 'mac', {}, registry)).toBeNull();
    expect(isTerminalKeptHotkey(ctrl1, 'mac', {}, registry)).toBe(true);
    expect(terminalYieldedCommandId(key({ key: '9', code: 'Digit9', metaKey: true }), 'mac', {}, registry)).toBe(
      'workbench.action.lastEditorInGroup',
    );
    expect(terminalYieldedCommandId(key({ key: '0', code: 'Digit0', ctrlKey: true }), 'mac', {}, registry)).toBe(
      'workbench.action.lastEditorInGroup',
    );
    expect(terminalYieldedCommandId(key({ key: '4', code: 'Digit4', metaKey: true }), 'mac', {}, registry)).toBe(
      'workbench.action.focusFourthEditorGroup',
    );
  });

  it('移动编辑器:带 ⌘ 的(mac ⌃⌘→)让出;不带的(Win/Linux Ctrl+Alt+→)交给 shell', () => {
    expect(
      terminalYieldedCommandId(key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, metaKey: true }), 'mac', {}, registry),
    ).toBe('workbench.action.moveEditorToNextGroup');
    const other = { getAll: () => editorCommandSpecs('other') };
    const ctrlAltRight = key({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true });
    expect(terminalYieldedCommandId(ctrlAltRight, 'other', {}, other)).toBeNull();
    expect(isTerminalKeptHotkey(ctrlAltRight, 'other', {}, other)).toBe(true);
  });
});
