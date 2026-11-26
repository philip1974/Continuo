// @vitest-environment jsdom
// BDD:拆分 / 聚焦编辑器组命令与 dock ↔ 编辑器组同步(对齐 VSCode)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { createTab, editorGroupIdsOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { editorCommandSpecs } from '../../panels/Editor/editor-commands';
import { focusEditorGroup, splitEditor } from '../../panels/Editor/editor-groups-actions';
import { reconcileEditorGroupsWithDock, trackEditorGroups } from '../../shell/dock/editor-groups-dock-sync';
import { closeDuplicateSingletonPanels } from '../../shell/dock/DockShell';
import { terminalYieldedCommandId } from '../../panels/Terminal/terminal-hotkeys';
import { applyDefaultLayout } from '../../shell/dock/layout.default';

const A = '/w/a.ts';
const B = '/w/b.ts';

type Listener = (panel: FakePanel | undefined) => void;

interface FakePanel {
  id: string;
  view: { contentComponent: string; content: { element: HTMLElement } };
  api: {
    id: string;
    isActive: boolean;
    setActive: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    group: { panels: FakePanel[] };
    /** dockview 组位置:popout = 在子窗里。 */
    location: { type: 'grid' | 'floating' | 'popout' };
  };
  /** 面板所在 dock 组(每个面板一组;位置随面板的 location)。 */
  group: FakeGroup;
}

interface FakeGroup {
  id: string;
  panels: FakePanel[];
  readonly activePanel: FakePanel | undefined;
  readonly api: { readonly location: { type: string } };
}

function fakeDock(ids: string[]) {
  const panels: FakePanel[] = [];
  const removed: Listener[] = [];
  const activated: Listener[] = [];
  const add = (id: string): FakePanel => {
    const group: FakeGroup = {
      id: `g-${id}`,
      panels: [],
      get activePanel() {
        return this.panels[0];
      },
      api: {
        get location() {
          return panel.api.location;
        },
      },
    };
    const panel: FakePanel = {
      id,
      view: { contentComponent: 'editor', content: { element: document.createElement('div') } },
      api: {
        id,
        isActive: false,
        setActive: vi.fn(),
        close: vi.fn(() => {
          panels.splice(panels.indexOf(panel), 1);
          for (const l of removed) l(panel);
        }),
        group,
        location: { type: 'grid' },
      },
      group,
    };
    group.panels.push(panel);
    panels.push(panel);
    return panel;
  };
  for (const id of ids) add(id);
  const addPanel = vi.fn((o: { id: string; position?: { referencePanel?: FakePanel; direction?: string } }) => {
    const panel = add(o.id);
    // 以 popout 面板为参照并入同组(within)→ 新面板同在子窗
    const ref = o.position?.referencePanel;
    if (ref && o.position?.direction === 'within') panel.api.location = { ...ref.api.location };
    return panel;
  });
  const api = {
    get panels() {
      return panels;
    },
    getPanel: (id: string) => panels.find((p) => p.id === id),
    get groups() {
      return panels.map((p) => p.group);
    },
    getGroup: (id: string) => panels.find((p) => p.group.id === id)?.group,
    /** 把面板标成在 popout 子窗里。 */
    popout: (id: string) => {
      panels.find((p) => p.id === id)!.api.location = { type: 'popout' };
    },
    addPanel,
    onDidRemovePanel: (l: Listener) => {
      removed.push(l);
      return { dispose: () => removed.splice(removed.indexOf(l), 1) };
    },
    onDidActivePanelChange: (l: Listener) => {
      activated.push(l);
      return { dispose: () => activated.splice(activated.indexOf(l), 1) };
    },
    activate: (panel: FakePanel) => {
      for (const l of activated) l(panel);
    },
  };
  return api;
}

function asApi(d: ReturnType<typeof fakeDock>): DockviewApi {
  return d as unknown as DockviewApi;
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    viewRefs: new Map(),
  });
});
afterEach(() => setDockApi(null));

describe('命令注册(VSCode 同名同键)', () => {
  it.each(['mac', 'other'] as const)('%s:拆分 mod+\\、向下拆分无默认键、聚焦第 1/2/3 组 mod+1/2/3', (platform) => {
    const specs = new Map(editorCommandSpecs(platform).map((c) => [c.id, c]));
    expect(specs.get('workbench.action.splitEditor')?.hotkey).toBe('mod+\\');
    expect(specs.has('workbench.action.splitEditorDown')).toBe(true);
    expect(specs.get('workbench.action.splitEditorDown')?.hotkey).toBeUndefined();
    expect(specs.get('workbench.action.focusFirstEditorGroup')?.hotkey).toBe('mod+1');
    expect(specs.get('workbench.action.focusSecondEditorGroup')?.hotkey).toBe('mod+2');
    expect(specs.get('workbench.action.focusThirdEditorGroup')?.hotkey).toBe('mod+3');
    expect(specs.get('workbench.action.splitEditor')?.titleKey).toBe('commands.editor.split.title');
  });

  it('终端里 ⌘\\ / ⌘1 让出给编辑器组命令(不进 shell)', () => {
    const registry = { getAll: () => editorCommandSpecs('mac') };
    const key = (key: string, code: string) =>
      new KeyboardEvent('keydown', { key, code, metaKey: true });
    expect(terminalYieldedCommandId(key('\\', 'Backslash'), 'mac', {}, registry)).toBe('workbench.action.splitEditor');
    expect(terminalYieldedCommandId(key('1', 'Digit1'), 'mac', {}, registry)).toBe('workbench.action.focusFirstEditorGroup');
  });
});

describe('splitEditor', () => {
  beforeEach(() => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    useEditorStore.getState().openTab(createTab(B, 'b'));
  });

  it('⌘\\:在活动组右侧新建 editor:2 面板,打开活动文件,新组成为活动组', () => {
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    expect(splitEditor('right')).toBe(true);
    expect(dock.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'editor:2',
        component: 'editor',
        position: { referencePanel: dock.getPanel('editor'), direction: 'right' },
      }),
    );
    const s = useEditorStore.getState();
    expect(groupTabsOf(s, 'editor:2').map((t) => t.id)).toEqual([B]);
    expect(s.activeGroupId).toBe('editor:2');
  });

  it('向下拆分 → direction below;tab 右键可指定文件', () => {
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    splitEditor('down', { groupId: 'editor', tabId: A });
    expect(dock.addPanel.mock.calls[0]![0]).toMatchObject({ position: { direction: 'below' } });
    expect(groupTabsOf(useEditorStore.getState(), 'editor:2').map((t) => t.id)).toEqual([A]);
  });

  it('新组 id 避开 dock 里已有的面板 id', () => {
    const dock = fakeDock(['editor', 'editor:2']);
    setDockApi(asApi(dock));
    splitEditor('right');
    expect(dock.addPanel.mock.calls[0]![0]).toMatchObject({ id: 'editor:3' });
  });

  it('源组面板不在 dock 里 → 不拆分', () => {
    setDockApi(asApi(fakeDock([])));
    expect(splitEditor('right')).toBe(false);
    expect(editorGroupIdsOf(useEditorStore.getState())).toEqual(['editor']);
  });
});

describe('focusEditorGroup(⌘1 / ⌘2 / ⌘3)', () => {
  it('聚焦已有的第 N 组:激活面板、成为活动组', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    splitEditor('right');
    focusEditorGroup(1);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
    expect(dock.getPanel('editor')!.api.setActive).toHaveBeenCalled();
  });

  it('N = 组数 + 1 → 在最后一个组右侧新建空组;更大 → no-op', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    focusEditorGroup(3);
    expect(dock.addPanel).not.toHaveBeenCalled();
    focusEditorGroup(2);
    expect(dock.addPanel.mock.calls[0]![0]).toMatchObject({ id: 'editor:2', position: { direction: 'right' } });
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:2']);
    expect(groupTabsOf(s, 'editor:2')).toEqual([]);
    expect(s.activeGroupId).toBe('editor:2');
  });

  // VSCode:⌘1/⌘2/⌘3 只按触发窗口(主窗)自己的编辑器组编号;popout 子窗里的组不计入,也不作新建组的参照。
  it('有组在 popout 子窗:主窗 ⌘N 只数主窗的组;不够时在主窗最后一组右侧新建,不建进子窗', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    splitEditor('right'); // editor:2
    splitEditor('right', { groupId: 'editor:2' }); // editor:3
    dock.popout('editor:2');
    dock.addPanel.mockClear();
    // 主窗的第 2 组 = editor:3(editor:2 在子窗)
    focusEditorGroup(2);
    expect(useEditorStore.getState().activeGroupId).toBe('editor:3');
    expect(dock.getPanel('editor:3')!.api.setActive).toHaveBeenCalled();
    expect(dock.addPanel).not.toHaveBeenCalled();
    // 主窗只有 2 组 → ⌘3 在主窗最后一组(editor:3)右侧新建空组
    focusEditorGroup(3);
    expect(dock.addPanel).toHaveBeenCalledTimes(1);
    const call = dock.addPanel.mock.calls[0]![0];
    expect(call.position).toMatchObject({ direction: 'right' });
    expect(call.position!.referencePanel!.id).toBe('editor:3');
    expect(dock.getPanel(call.id)!.api.location.type).not.toBe('popout');
    expect(useEditorStore.getState().activeGroupId).toBe(call.id);
  });

  it('最后一个组在 popout 子窗:主窗 ⌘2 仍以主窗的组为参照新建,不进子窗', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    splitEditor('right'); // editor:2(最后一组)
    dock.popout('editor:2');
    dock.addPanel.mockClear();
    focusEditorGroup(2);
    const call = dock.addPanel.mock.calls[0]![0];
    expect(call.position!.referencePanel!.id).toBe('editor');
    expect(call.position).toMatchObject({ direction: 'right' });
    expect(dock.getPanel(call.id)!.api.location.type).not.toBe('popout');
  });
});

describe('dock ↔ 编辑器组同步', () => {
  it('组随最后一个 tab 关闭 → 关闭其 dock 面板', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    const sub = trackEditorGroups(asApi(dock));
    splitEditor('right');
    const panel = dock.getPanel('editor:2')!;
    useEditorStore.getState().closeTab(A, 'editor:2');
    expect(panel.api.close).toHaveBeenCalled();
    sub.dispose();
  });

  it('dock 面板被关掉 → 移除该组(脏文档移到相邻组)', async () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    const sub = trackEditorGroups(asApi(dock));
    splitEditor('right');
    useEditorStore.getState().openTab(createTab(B, 'b'));
    useEditorStore.getState().updateContent(B, 'changed');
    dock.getPanel('editor:2')!.api.close();
    await Promise.resolve();
    const s = useEditorStore.getState();
    expect(editorGroupIdsOf(s)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A, B]);
    sub.dispose();
  });

  it('dock 激活编辑器组面板 → 活动编辑器组', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    const sub = trackEditorGroups(asApi(dock));
    splitEditor('right');
    dock.activate(dock.getPanel('editor')!);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
    sub.dispose();
  });

  it('单例去重不关闭编辑器组面板 editor:2', () => {
    const dock = fakeDock(['editor', 'editor:2']);
    closeDuplicateSingletonPanels(asApi(dock), { get: () => ({}) });
    expect(dock.getPanel('editor:2')!.api.close).not.toHaveBeenCalled();
  });

  it('启动对齐:没有面板的组并入有面板的组,不属于任何组的多余编辑器面板关闭', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    useEditorStore.getState().openTab(createTab(B, 'b'));
    useEditorStore.getState().restoreGroups(
      [
        { id: 'editor', tabIds: [A], activeTabId: A },
        { id: 'editor:5', tabIds: [B], activeTabId: B },
      ],
      'editor',
    );
    const dock = fakeDock(['editor', 'editor:9', 'editor:8']);
    reconcileEditorGroupsWithDock(asApi(dock));
    const s = useEditorStore.getState();
    // editor:5 没有面板 → 搬到空着的 editor:9;多出的 editor:8 关闭
    expect(editorGroupIdsOf(s)).toEqual(['editor', 'editor:9']);
    expect(groupTabsOf(s, 'editor:9').map((t) => t.id)).toEqual([B]);
    expect(dock.getPanel('editor:8')).toBeUndefined();
  });

  it('恢复默认布局补建的是活动编辑器组的面板(拆分后只剩 editor:2 时不另起空的 editor 组)', () => {
    useEditorStore.getState().openTab(createTab(A, 'a'));
    const dock = fakeDock(['editor']);
    setDockApi(asApi(dock));
    splitEditor('right');
    useEditorStore.getState().closeTab(A, 'editor');
    expect(editorGroupIdsOf(useEditorStore.getState())).toEqual(['editor:2']);
    const empty = fakeDock([]);
    applyDefaultLayout(asApi(empty));
    expect(empty.addPanel.mock.calls[0]![0]).toMatchObject({ id: 'editor:2', component: 'editor' });
  });
});
