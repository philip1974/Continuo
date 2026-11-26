// @vitest-environment jsdom
// BDD:popout 子窗里按 ⇧⌘T 重新打开已关闭的编辑器 —— 落在触发的子窗里(VSCode:辅助窗口里重开落到该窗口的编辑器组),
// 不在主窗打开而子窗毫无反馈。见同目录 README 第 6 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { createTab, editorGroupIdsOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { reopenClosedEditor } from '../../panels/Editor/reopen-closed-editor';
import { clearRecentlyClosedEditors } from '../../panels/Editor/recently-closed-editors';
import { registerEditorFocus } from '../../panels/Editor/editor-focus-registry';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { POPOUT_HOTKEY_COMMAND_IDS } from '../../plugins/command-palette/useCommandHotkeys';
import { REOPEN_CLOSED_EDITOR_COMMAND } from '../../panels/Editor/editor-commands';
import type { EditorFileDeps } from '../../panels/Editor/editor-file-actions';

const A = '/w/a.ts';
const B = '/w/b.ts';

const st = () => useEditorStore.getState();
const ids = (groupId: string): string[] => groupTabsOf(st(), groupId).map((t) => t.id);
const disk = {
  fs: { readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `disk ${p}` })), writeFile: vi.fn() },
} as unknown as EditorFileDeps;

const mainWin = { name: 'main' };
const childWin = { name: 'child' };

interface FakePanel {
  id: string;
  group: { id: string };
  api: { location: { type: string }; getWindow: () => unknown };
}

/** 假 dock:panels 里各面板所在窗口;active = 当前活动面板(焦点所在窗口)。 */
function fakeDock(panels: FakePanel[], active: string) {
  const addPanel = vi.fn((o: { id: string; position?: { referenceGroup?: { id: string } } }) => {
    const group = o.position?.referenceGroup ?? { id: 'g-new' };
    const ref = panels.find((p) => p.group === group);
    const panel: FakePanel = { id: o.id, group, api: ref ? ref.api : { location: { type: 'grid' }, getWindow: () => mainWin } };
    panels.push(panel);
    return panel;
  });
  setDockApi({
    get panels() {
      return panels;
    },
    get activePanel() {
      return panels.find((p) => p.id === active);
    },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    addPanel,
  } as unknown as DockviewApi);
  return { addPanel };
}

const inMain = (id: string, group = 'g-main'): FakePanel => ({
  id,
  group: { id: group },
  api: { location: { type: 'grid' }, getWindow: () => mainWin },
});
const popoutGroup = { id: 'g-child' };
const inChild = (id: string): FakePanel => ({
  id,
  group: popoutGroup,
  api: { location: { type: 'popout' }, getWindow: () => childWin },
});

const C = '/w/c.ts';

/** 两个组:editor(主窗)开 A;editor:2(子窗)开 B(+ C,关掉 B 后组仍在)。 */
function twoGroups(withC = true): void {
  st().openTab(createTab(A, 'disk a'));
  st().splitGroup('editor', 'editor:2', null);
  st().openTab(createTab(B, 'disk b'), { groupId: 'editor:2' });
  if (withC) st().openTab(createTab(C, 'disk c'), { groupId: 'editor:2' });
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
    viewRefs: new Map(),
  });
  clearRecentlyClosedEditors();
});
afterEach(() => setDockApi(null));

describe('popout 子窗里 ⇧⌘T', () => {
  it('子窗分发重新打开已关闭的编辑器(同 ⌘W)', () => {
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(REOPEN_CLOSED_EDITOR_COMMAND.id)).toBe(true);
  });

  it('在子窗编辑器组里关的 → 回到该组(子窗里),焦点进该组重开的编辑器', async () => {
    twoGroups();
    fakeDock([inMain('editor'), inChild('editor:2')], 'editor:2');
    st().closeTab(B, 'editor:2');
    const focused: string[] = [];
    const off = registerEditorFocus(B, () => focused.push('editor:2'), 'editor:2');

    expect(await reopenClosedEditor(disk)).toBe(true);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    expect(ids('editor:2')).toContain(B);
    expect(st().activeGroupId).toBe('editor:2');
    expect(focused).toEqual(['editor:2']);
    off();
  });

  it('原组在主窗、在子窗里按 → 落到子窗的编辑器组(不在主窗打开)', async () => {
    twoGroups();
    st().openTab(createTab('/w/d.ts', 'disk d'), { groupId: 'editor' });
    fakeDock([inMain('editor'), inChild('editor:2')], 'editor:2');
    st().closeTab(A, 'editor');
    expect(editorGroupIdsOf(st())).toEqual(['editor', 'editor:2']); // 原组仍在

    expect(await reopenClosedEditor(disk)).toBe(true);
    expect(ids('editor:2')).toContain(A);
    expect(ids('editor')).not.toContain(A);
    expect(st().activeGroupId).toBe('editor:2');
  });

  it('子窗里没有编辑器组(原组已随关闭移除,子窗只剩终端)→ 在子窗里新建编辑器组打开', async () => {
    twoGroups(false);
    st().closeTab(B, 'editor:2'); // editor:2 随最后一个 tab 关闭(closeEmptyGroups)
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    const { addPanel } = fakeDock([inMain('editor'), inChild('terminal-1')], 'terminal-1');

    expect(await reopenClosedEditor(disk)).toBe(true);

    const created = st().activeGroupId;
    expect(created).not.toBe('editor');
    expect(ids(created)).toEqual([B]);
    expect(addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: created, component: 'editor', position: { referenceGroup: popoutGroup } }),
    );
    expect(ids('editor')).not.toContain(B);
  });

  it('主窗里按 → 不变:原组还在就回原组(即使原组在子窗)', async () => {
    twoGroups();
    fakeDock([inMain('editor'), inChild('editor:2')], 'editor');
    st().closeTab(B, 'editor:2');
    expect(await reopenClosedEditor(disk)).toBe(true);
    expect(ids('editor:2')).toContain(B);
  });
});
