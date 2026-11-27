// @vitest-environment jsdom
// BDD:dock tab 与编辑器 tab 的双击 / 右键「最大化组」(见同目录 README):
//   - dock tab 双击 → 展开该组 / 再次全部等分;双击关闭按钮不算;
//   - 编辑器常驻 tab 双击 → 展开该编辑器组;预览 tab 双击仍是转常驻(不改组大小);
//   - 两种 tab 的右键菜单末尾有「最大化组」,最大化后为「取消最大化组」;只有一个组时不列。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { SharedTab } from '@/shell/motion/SharedTab';
import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { EditorGroupIdContext } from '@/panels/Editor/editor-group-context';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { isGroupExpanded } from '@/shell/dock/group-sizes';
import { createTab, groupPreviewTabIdOf, useEditorStore } from '@/stores/editor.store';
import { coApp } from '@/plugins/co-app';
import { EditorActionRegistry } from '@/plugins/registries/EditorActionRegistry';
import { setLocale } from '@/i18n';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** 两列真实 dockview:editor | t1(宽 1200)。 */
function twoColumns(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  dock.api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  dock.api.addPanel({ id: 't1', component: 'terminal', title: 'T1', position: { referencePanel: 'editor', direction: 'right' } });
  dock.layout(1200, 600);
  return dock.api;
}

function renderDockTab(api: DockviewApi, id: string) {
  const panel = api.getPanel(id)!;
  const props = { api: panel.api, containerApi: api, params: {} } as unknown as Parameters<typeof SharedTab>[0];
  return render(<SharedTab {...props} />);
}

const menuLabels = () => Array.from(document.querySelectorAll('[role=menuitem]')).map((el) => el.textContent ?? '');
const group = (api: DockviewApi, id: string) => api.getPanel(id)!.group;

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('dock tab', () => {
  it('双击 → 展开该组;再双击 → 等分', () => {
    const api = twoColumns();
    renderDockTab(api, 't1');
    const tab = screen.getByRole('tab');
    fireEvent.doubleClick(tab);
    expect(isGroupExpanded(api, group(api, 't1'))).toBe(true);
    expect(group(api, 'editor').api.width).toBe(group(api, 'editor').minimumWidth);
    fireEvent.doubleClick(tab);
    expect(isGroupExpanded(api, group(api, 't1'))).toBe(false);
    expect(Math.abs(group(api, 'editor').api.width - group(api, 't1').api.width)).toBeLessThanOrEqual(1);
  });

  it('双击关闭按钮不改组大小', () => {
    const api = twoColumns();
    renderDockTab(api, 't1');
    const close = screen.getByRole('button', { name: /Close/ });
    const before = group(api, 't1').api.width;
    fireEvent.doubleClick(close);
    expect(group(api, 't1').api.width).toBe(before);
  });

  it('右键菜单末尾「Maximize Group」→ 最大化;再右键为「Unmaximize Group」→ 取消', () => {
    const api = twoColumns();
    renderDockTab(api, 't1');
    const tab = screen.getByRole('tab');
    fireEvent.contextMenu(tab);
    expect(menuLabels().at(-1)).toBe('Maximize Group');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Maximize Group' }));
    expect(group(api, 't1').api.isMaximized()).toBe(true);
    fireEvent.contextMenu(tab);
    expect(menuLabels().at(-1)).toBe('Unmaximize Group');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmaximize Group' }));
    expect(api.hasMaximizedGroup()).toBe(false);
  });

  it('只有一个组 → 菜单里没有「Maximize Group」', () => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const dock = new DockviewComponent(container, {
      createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    });
    dock.api.addPanel({ id: 't1', component: 'terminal', title: 'T1' });
    renderDockTab(dock.api, 't1');
    fireEvent.contextMenu(screen.getByRole('tab'));
    expect(menuLabels()).not.toContain('Maximize Group');
  });
});

describe('编辑器 tab', () => {
  beforeEach(() => {
    (coApp as { editorActions: EditorActionRegistry }).editorActions = new EditorActionRegistry();
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
      activeGroupId: 'editor',
      tabMru: new Map(),
      previewTabs: new Map(),
      mode: 'source',
    });
    const st = useEditorStore.getState();
    st.openTab(createTab('/w/a.ts', ''));
    st.openTab(createTab('/w/b.ts', ''), { preview: true });
  });

  function renderHeader(api: DockviewApi) {
    setDockApi(api);
    return render(
      <EditorGroupIdContext.Provider value="editor">
        <EditorHeader onCloseRequest={vi.fn()} onCloseTabsRequest={vi.fn()} />
      </EditorGroupIdContext.Provider>,
    );
  }

  it('双击常驻 tab → 展开该编辑器组所在的 dock 组;再双击 → 等分', () => {
    const api = twoColumns();
    renderHeader(api);
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'a.ts' }));
    expect(isGroupExpanded(api, group(api, 'editor'))).toBe(true);
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'a.ts' }));
    expect(isGroupExpanded(api, group(api, 'editor'))).toBe(false);
  });

  it('双击预览 tab → 转常驻,组大小不变', () => {
    const api = twoColumns();
    renderHeader(api);
    const before = group(api, 'editor').api.width;
    fireEvent.doubleClick(screen.getByRole('tab', { name: /^b\.ts, preview$/ }));
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor')).toBeUndefined();
    expect(group(api, 'editor').api.width).toBe(before);
  });

  it('右键菜单末尾「Maximize Group」→ 最大化编辑器组所在的 dock 组', () => {
    const api = twoColumns();
    renderHeader(api);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'a.ts' }));
    expect(menuLabels().at(-1)).toBe('Maximize Group');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Maximize Group' }));
    expect(group(api, 'editor').api.isMaximized()).toBe(true);
  });
});
