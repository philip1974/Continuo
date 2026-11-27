// @vitest-environment jsdom
// BDD:在侧边打开(VSCode SIDE_GROUP)落到哪个编辑器组、焦点与活动组。见同目录 README「行为 2 / 3」。
// 真实 dockview + 编辑器 store + 真实拆分(splitEditor);读文件与编辑器聚焦打桩。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { useEditorStore, groupPreviewTabIdOf, type EditorTab } from '@/stores/editor.store';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `// ${p}` })),
  requestEditorFocus: vi.fn(),
}));

vi.mock('@/panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
vi.mock('@/panels/Editor/editor-focus-registry', async (orig) => ({
  ...(await orig<typeof import('@/panels/Editor/editor-focus-registry')>()),
  requestEditorFocus: mocks.requestEditorFocus,
}));

import { openFilesToSide } from '@/shell/dock/explorer-editor-drop';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { rightNeighborGroup } from '@/shell/dock/group-sizes';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const A = '/w/a.ts';
const B = '/w/b.ts';

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  dock.layout(1200, 600);
  setDockApi(dock.api);
  return dock.api;
}

const group = (id: string) => useEditorStore.getState().groups.find((g) => g.id === id);
const tabIdOf = (path: string) => useEditorStore.getState().tabs.find((t: EditorTab) => t.filePath === path)!.id;
const pathsIn = (id: string) =>
  group(id)!.tabIds.map((tid) => useEditorStore.getState().tabs.find((t) => t.id === tid)!.filePath);

function setGroups(ids: string[], active: string) {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: ids.map((id) => ({ id, tabIds: [], activeTabId: null })),
    activeGroupId: active,
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
}

beforeEach(() => {
  mocks.readFile.mockClear();
  mocks.requestEditorFocus.mockReset();
});
afterEach(() => {
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('右键菜单 / ⌃Enter:常驻、侧边组获焦', () => {
  it('活动组右边已有编辑器组 → 在它里面常驻打开,它成为活动组并请求聚焦', async () => {
    setGroups(['editor', 'editor:2'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });
    api.addPanel({ id: 'editor:2', component: 'editor', title: 'E2', position: { referencePanel: 'editor', direction: 'right' } });
    api.getPanel('editor')!.api.setActive();

    await openFilesToSide([A, B]);
    expect(pathsIn('editor:2')).toEqual([A, B]);
    expect(pathsIn('editor')).toEqual([]);
    expect(group('editor:2')!.activeTabId).toBe(tabIdOf(A));
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor:2')).toBeUndefined();
    expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
    expect(mocks.requestEditorFocus).toHaveBeenCalledWith(tabIdOf(A), 'editor:2');
  });

  it('右边没有编辑器组 → 向右拆出新组并在其中打开(dock 里新组在源组右侧)', async () => {
    setGroups(['editor'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });

    await openFilesToSide([A]);
    const ids = useEditorStore.getState().groups.map((g) => g.id);
    expect(ids).toHaveLength(2);
    const side = ids.find((id) => id !== 'editor')!;
    expect(pathsIn(side)).toEqual([A]);
    expect(useEditorStore.getState().activeGroupId).toBe(side);
    const sourceGroup = api.getPanel('editor')!.group;
    const sideGroup = api.getPanel(side)!.group;
    expect(sideGroup).not.toBe(sourceGroup);
    expect(rightNeighborGroup(api, sourceGroup)).toBe(sideGroup);
  });

  it('右边紧挨着的是终端等非编辑器组 → 不放进去,在源组右侧拆出新编辑器组', async () => {
    setGroups(['editor'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });
    api.addPanel({ id: 'terminal-1', component: 'terminal', title: 'T', position: { referencePanel: 'editor', direction: 'right' } });
    api.getPanel('editor')!.api.setActive();

    await openFilesToSide([A]);
    const side = useEditorStore.getState().groups.map((g) => g.id).find((id) => id !== 'editor')!;
    expect(pathsIn(side)).toEqual([A]);
    expect(api.getPanel('terminal-1')!.group.panels.map((p) => p.id)).toEqual(['terminal-1']);
    // 新组在源组与终端之间
    expect(rightNeighborGroup(api, api.getPanel('editor')!.group)).toBe(api.getPanel(side)!.group);
    expect(rightNeighborGroup(api, api.getPanel(side)!.group)).toBe(api.getPanel('terminal-1')!.group);
  });
});

describe('⌥ 单击:预览、焦点留在资源管理器、活动组不变', () => {
  it('以预览方式打开到侧边组,活动编辑器组仍是源组,不请求聚焦;再次 ⌥ 单击仍落在同一个侧边组(不再拆分)', async () => {
    setGroups(['editor'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });

    await openFilesToSide([A], { preview: true, preserveFocus: true });
    const ids = useEditorStore.getState().groups.map((g) => g.id);
    expect(ids).toHaveLength(2);
    const side = ids.find((id) => id !== 'editor')!;
    expect(groupPreviewTabIdOf(useEditorStore.getState(), side)).toBe(tabIdOf(A));
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
    expect(api.activePanel?.id).toBe('editor');
    expect(mocks.requestEditorFocus).not.toHaveBeenCalled();

    await openFilesToSide([B], { preview: true, preserveFocus: true });
    expect(useEditorStore.getState().groups).toHaveLength(2);
    // 预览 tab 原位替换
    expect(pathsIn(side)).toEqual([B]);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
  });
});
