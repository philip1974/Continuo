// @vitest-environment jsdom
// BDD:「视图:重置布局」(VSCode View: Reset View Locations 类)—— 有面板时也能把拖乱的布局收回默认形态,不关闭任何面板。
// 见同目录 README。用真实 dockview(jsdom)+ 假 popout 子窗。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { resetDockLayout } from '@/shell/dock/layout.default';
import { dockCommandSpecs } from '@/shell/dock/dock-panel-actions';
import { markDockLayoutRestored, setDockApi } from '@/shell/dock/dock-api-ref';
import { useEditorStore } from '@/stores/editor.store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

afterEach(() => {
  setDockApi(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const editorId = () => useEditorStore.getState().activeGroupId;

/** 编辑器 + 两个终端 + 输出:向右 / 向下拆分、一个浮动组。 */
function messyDock() {
  const dock = createDock();
  const api = dock.api as DockviewApi;
  api.addPanel({ id: editorId(), component: 'editor', title: 'Editor' });
  api.addPanel({ id: 'terminal-a', component: 'terminal', title: 'zsh', position: { direction: 'right' } });
  api.addPanel({ id: 'terminal-b', component: 'terminal', title: 'sleep', position: { direction: 'below' } });
  api.addPanel({ id: 'output-1', component: 'output', title: 'Output', floating: true });
  return { dock, api };
}

const visibleGroupsWithPanels = (api: DockviewApi) => api.groups.filter((g) => g.panels.length > 0);

describe('重置布局', () => {
  it('拆分 / 浮动的面板全部收回主窗同一个组,一个都不关闭;编辑器为活动面板', () => {
    const { api } = messyDock();
    expect(visibleGroupsWithPanels(api).length).toBe(4);
    const closed: string[] = [];
    api.onDidRemovePanel((p) => closed.push(p.id));

    resetDockLayout(api);

    const groups = visibleGroupsWithPanels(api);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.api.location.type).toBe('grid');
    expect(groups[0]!.panels.map((p) => p.id).sort()).toEqual([editorId(), 'output-1', 'terminal-a', 'terminal-b'].sort());
    expect(closed).toEqual([]);
    expect(api.activePanel?.id).toBe(editorId());
  });

  it('popout 子窗里的面板一并收回主窗(子窗关闭),面板不重建', async () => {
    const { dock, api } = messyDock();
    const terminal = api.getPanel('terminal-a')!;
    await openFakePopout(dock, 'terminal-a');
    expect(terminal.api.location.type).toBe('popout');

    resetDockLayout(api);

    expect(api.getPanel('terminal-a')).toBe(terminal);
    expect(terminal.api.location.type).toBe('grid');
    expect(api.groups.some((g) => g.api.location.type === 'popout')).toBe(false);
    expect(visibleGroupsWithPanels(api)).toHaveLength(1);
  });

  it('最大化的组先退出最大化', () => {
    const { api } = messyDock();
    api.getPanel('terminal-a')!.group.api.maximize();
    expect(api.hasMaximizedGroup()).toBe(true);
    resetDockLayout(api);
    expect(api.hasMaximizedGroup()).toBe(false);
  });

  it('编辑器面板已关:收回其余面板并重新打开编辑器(同空状态「恢复默认布局」)', () => {
    const { api } = messyDock();
    api.getPanel(editorId())!.api.close();
    resetDockLayout(api);
    expect(api.getPanel(editorId())).toBeDefined();
    expect(api.activePanel?.id).toBe(editorId());
    expect(visibleGroupsWithPanels(api)).toHaveLength(1);
  });

  it('全部面板都关了(空状态):只打开编辑器', () => {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    resetDockLayout(api);
    expect(api.panels.map((p) => p.id)).toEqual([editorId()]);
  });

  it('注册为命令 workbench.action.resetViewLocations(视图分类,三语标题,无默认键),执行即重置当前窗口布局', async () => {
    const spec = dockCommandSpecs().find((c) => c.id === 'workbench.action.resetViewLocations');
    expect(spec).toBeDefined();
    expect(spec!.hotkey).toBeUndefined();
    const key = spec!.titleKey as keyof typeof en;
    expect(en[key]).toBe('Reset Layout');
    expect(zh[key]).toBe('重置布局');
    expect(ko[key]).toBe('레이아웃 초기화');
    expect(en[spec!.categoryKey as keyof typeof en]).toBe('View');

    const { api } = messyDock();
    setDockApi(api);
    markDockLayoutRestored(api);
    await spec!.fn();
    expect(visibleGroupsWithPanels(api)).toHaveLength(1);
  });
});
