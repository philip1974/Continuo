// @vitest-environment jsdom
// BDD: open-to-side-from-pickers —— takeSideEditorGroup 的侧边组规则(真实 dockview + 编辑器 store + 真实拆分)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { useEditorStore } from '@/stores/editor.store';
import { takeSideEditorGroup } from '@/shell/dock/explorer-editor-drop';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { rightNeighborGroup } from '@/shell/dock/group-sizes';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

afterEach(() => {
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('takeSideEditorGroup', () => {
  it('右边已有编辑器组 → 它(不再拆分)', () => {
    setGroups(['editor', 'editor:2'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });
    api.addPanel({ id: 'editor:2', component: 'editor', title: 'E2', position: { referencePanel: 'editor', direction: 'right' } });
    api.getPanel('editor')!.api.setActive();
    expect(takeSideEditorGroup()).toBe('editor:2');
    expect(useEditorStore.getState().groups).toHaveLength(2);
  });

  it('右边没有编辑器组 → 向右拆出新组并返回它', () => {
    setGroups(['editor'], 'editor');
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'E1' });
    const side = takeSideEditorGroup()!;
    expect(side).not.toBe('editor');
    expect(useEditorStore.getState().groups.map((g) => g.id)).toContain(side);
    expect(rightNeighborGroup(api, api.getPanel('editor')!.group)).toBe(api.getPanel(side)!.group);
  });

  it('dock 未就绪 → undefined(按普通方式在活动组打开)', () => {
    setGroups(['editor'], 'editor');
    expect(takeSideEditorGroup()).toBeUndefined();
  });
});
