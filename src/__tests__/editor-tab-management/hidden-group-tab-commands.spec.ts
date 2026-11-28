// @vitest-environment jsdom
// BDD:设置页 / 冲突比较页等非编辑器面板挡在编辑器组前面(同一 dock 组里是活动面板)时,tab 级键盘命令(移动编辑器 ⌃⌘← / →…、
// 按序号打开 ⌃1…⌃9 / ⌃0、下一个 / 上一个编辑器 ⌥⌘← / →、组内循环)不去动藏在后面看不见的文件;编辑器组可见(焦点在别的组的终端)
// 照旧作用于它。tab 右键「移到上一组 / 下一组」(显式指定组与 tab)不受影响。见同目录 README 第 7 条。
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

import type { DockviewApi } from 'dockview-react';
import { createTab, groupActiveTabIdOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import {
  openAdjacentEditor,
  openAdjacentEditorInGroup,
  openEditorAtIndex,
} from '../../panels/Editor/editor-commands';
import { moveEditor } from '../../panels/Editor/editor-groups-actions';
import { setDockApi } from '../../shell/dock/dock-api-ref';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';

const st = () => useEditorStore.getState();
const ids = () => groupTabsOf(st(), 'editor').map((t) => t.id);

interface FakePanel {
  id: string;
  view: { contentComponent: string };
  api: { id: string; isActive: boolean; isVisible: boolean; setActive: () => void; location: { type: 'grid' } };
  group: { id: string; api: { location: { type: 'grid' } }; panels: FakePanel[]; activePanel: FakePanel | undefined };
}

/**
 * 主窗 dock:editor 组面板与 other 面板。sameGroup = true → 两者叠在同一 dock 组,other 是活动面板(editor 被挡住、不可见);
 * false → 各在一组,other 活动但 editor 仍可见。
 */
function dock(other: { id: string; component: string }, sameGroup: boolean): FakePanel {
  const mk = (id: string, component: string, visible: boolean, active: boolean): FakePanel => {
    const panel: FakePanel = {
      id,
      view: { contentComponent: component },
      api: { id, isActive: active, isVisible: visible, setActive: vi.fn(), location: { type: 'grid' } },
      group: { id: `g-${id}`, api: { location: { type: 'grid' } }, panels: [], activePanel: undefined },
    };
    panel.group.panels.push(panel);
    panel.group.activePanel = panel;
    return panel;
  };
  const editor = mk('editor', 'editor', !sameGroup, false);
  const front = mk(other.id, other.component, true, true);
  if (sameGroup) {
    front.group = editor.group;
    editor.group.panels.push(front);
    editor.group.activePanel = front;
  }
  const panels = [editor, front];
  setDockApi({
    get activePanel() {
      return front;
    },
    get panels() {
      return panels;
    },
    get groups() {
      return [...new Set(panels.map((p) => p.group))];
    },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    getGroup: (id: string) => panels.find((p) => p.group.id === id)?.group,
  } as unknown as DockviewApi);
  return front;
}

beforeEach(() => {
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
  for (const p of [A, B, C]) st().openTab(createTab(p, p));
  st().switchTab(B, { groupId: 'editor' });
});

describe('设置页 / 比较页挡在编辑器组前面 → tab 级命令不动看不见的文件', () => {
  it.each([
    ['设置页', { id: 'settings', component: 'settings' }],
    ['冲突比较页', { id: 'conflict-diff:/w/a.ts', component: 'conflict-diff' }],
  ])('%s:移动编辑器、按序号打开、下一个 / 上一个编辑器、组内循环都 no-op', (_name, other) => {
    dock(other, true);
    expect(moveEditor('right')).toBe(false);
    expect(moveEditor('left')).toBe(false);
    expect(moveEditor('next')).toBe(false);
    expect(moveEditor('first')).toBe(false);
    openEditorAtIndex(1);
    openEditorAtIndex(Infinity);
    openAdjacentEditor(1);
    openAdjacentEditor(-1);
    openAdjacentEditorInGroup(1);
    expect(ids()).toEqual([A, B, C]);
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(B);
  });

  it('tab 右键「移到…」(显式指定组与 tab)照常生效', () => {
    dock({ id: 'settings', component: 'settings' }, true);
    expect(moveEditor('right', { groupId: 'editor', tabId: B })).toBe(true);
    expect(ids()).toEqual([A, C, B]);
  });
});

describe('编辑器组可见(活动面板在别的组,如旁边的终端)→ 照旧作用于它', () => {
  it('移动编辑器 / 按序号打开 / 下一个编辑器生效', () => {
    dock({ id: 'terminal:1', component: 'terminal' }, false);
    expect(moveEditor('right')).toBe(true);
    expect(ids()).toEqual([A, C, B]);
    openEditorAtIndex(1);
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(A);
    openAdjacentEditor(1);
    expect(groupActiveTabIdOf(st(), 'editor')).toBe(C);
  });
});
