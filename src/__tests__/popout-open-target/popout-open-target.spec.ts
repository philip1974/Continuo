// @vitest-environment jsdom
// BDD:活动组在 popout 子窗时,从主窗入口打开 / 切换面板落在主窗(VSCode:在触发的窗口打开)。见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';
import { markDockLayoutRestored, openOrFocusPanel, setDockApi } from '@/shell/dock/dock-api-ref';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { toggleSettingsPanel } from '@/lib/toggle-settings-panel';
import { reconcileTerminalPanels } from '@/shell/dock/DockReconciler';
import { useLayoutUiStore } from '@/stores/layout-ui.store';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let mru: { dispose(): void } | null = null;

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  mru = trackGroupMru(dock.api);
  return dock.api;
}

/** 把面板所在组标成 popout 子窗(dockview addPopoutGroup 挂上后的 location),返回子窗的 focus 桩。 */
function popOut(panel: IDockviewPanel): ReturnType<typeof vi.fn> {
  const focus = vi.fn();
  const group = panel.group as unknown as { model: { location: unknown } };
  // 子窗 window 桩:可挂监听(group-mru 跟踪子窗焦点)+ focus 桩
  const win = Object.assign(new EventTarget(), { focus, document: document.implementation.createHTMLDocument() });
  group.model.location = { type: 'popout', getWindow: () => win };
  return focus;
}

/** 主窗:editor;popout 子窗:ui44(活动组)。 */
function dockWithPopoutActive(): { api: DockviewApi; popoutFocus: ReturnType<typeof vi.fn> } {
  const api = createDock();
  api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44', position: { direction: 'right' } });
  const popoutFocus = popOut(ui);
  ui.api.setActive();
  setDockApi(api);
  markDockLayoutRestored(api);
  return { api, popoutFocus };
}

const windowOf = (panel: IDockviewPanel | undefined) =>
  panel?.api.location.type === 'popout' ? 'popout' : 'main';

beforeEach(() => {
  useLayoutUiStore.setState({ sidebarOpen: true });
});

afterEach(() => {
  mru?.dispose();
  mru = null;
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('活动组在 popout 子窗时从主窗打开面板', () => {
  it('⌘, / 齿轮:新建的设置面板落在主窗最近使用的组(与 editor 同组),不进 popout', () => {
    const { api } = dockWithPopoutActive();
    toggleSettingsPanel();
    const settings = api.getPanel('settings');
    expect(settings).toBeDefined();
    expect(windowOf(settings)).toBe('main');
    expect(settings!.group).toBe(api.getPanel('editor')!.group);
    expect(api.activePanel).toBe(settings);
  });

  it('插件 / 单例面板(app.dock.openPanel 等经 openOrFocusPanel)同样落在主窗', () => {
    const { api } = dockWithPopoutActive();
    openOrFocusPanel('debug', 'debug', 'Debug');
    expect(windowOf(api.getPanel('debug'))).toBe('main');
  });

  it('主窗没有任何面板(全弹出)→ 在主窗新建一组放入,不进 popout', () => {
    const api = createDock();
    const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44' });
    popOut(ui);
    ui.api.setActive();
    setDockApi(api);
    toggleSettingsPanel();
    const settings = api.getPanel('settings')!;
    expect(windowOf(settings)).toBe('main');
    expect(settings.group).not.toBe(ui.group);
  });

  it('活动组在主窗 → 照旧落在活动组', () => {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh', position: { direction: 'right' } });
    term.api.setActive();
    setDockApi(api);
    toggleSettingsPanel();
    expect(api.getPanel('settings')!.group).toBe(term.group);
  });
});

/**
 * 整组弹出后主窗只剩 dockview 留在 grid 里的隐藏引用组(0 宽、无面板);主窗关光其余面板后 dockview 把活动组置成它。
 * 返回 { api, ref, ui }。
 */
function onlyHiddenReferenceGroupActive() {
  const api = createDock();
  const ref = api.addGroup();
  const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44', position: { direction: 'right' } });
  popOut(ui);
  ref.api.setVisible(false);
  ref.api.setActive();
  setDockApi(api);
  markDockLayoutRestored(api);
  return { api, ref, ui };
}

describe('主窗只剩隐藏的 popout 引用组且它是活动组', () => {
  it('前提:活动组在主窗 grid 但不可见、没有面板', () => {
    const { api, ref } = onlyHiddenReferenceGroupActive();
    expect(api.activeGroup).toBe(ref);
    expect(ref.api.location.type).toBe('grid');
    expect(ref.api.isVisible).toBe(false);
  });

  it('⌘, / 单例面板 / 显示输出 → 在主窗新建可见的组,不落进 0 宽的隐藏组', () => {
    const { api, ref } = onlyHiddenReferenceGroupActive();
    toggleSettingsPanel();
    openOrFocusPanel('output', 'output', 'Output');
    for (const id of ['settings', 'output']) {
      const panel = api.getPanel(id)!;
      expect(windowOf(panel)).toBe('main');
      expect(panel.group).not.toBe(ref);
      expect(panel.group.api.isVisible).toBe(true);
    }
    expect(ref.panels).toHaveLength(0);
  });

  it('打开后关光再打开(主窗回到空态再「显示输出」)→ 仍落在可见的组', () => {
    const { api, ref, ui } = onlyHiddenReferenceGroupActive();
    ui.api.setActive(); // 刚弹出:活动组是子窗的组 → 第一次打开落在主窗新建的组(此前也正常)
    openOrFocusPanel('output', 'output', 'Output');
    expect(api.getPanel('output')!.group).not.toBe(ref);
    api.getPanel('output')!.api.close();
    ref.api.setActive(); // dockview 移除活动组后兜底激活 groups[0](即隐藏引用组)
    openOrFocusPanel('output', 'output', 'Output');
    const output = api.getPanel('output')!;
    expect(output.group).not.toBe(ref);
    expect(output.group.api.isVisible).toBe(true);
  });

  it('新终端(无 grid 终端可作参照)→ 同样不落进隐藏组', () => {
    const { api, ref } = onlyHiddenReferenceGroupActive();
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [{ id: 's1', title: 'zsh', originHint: 'user', createdAt: 1, status: 'running' } as never],
    } as never);
    const term = api.panels.find((p) => p.id !== 'ui44')!;
    expect(windowOf(term)).toBe('main');
    expect(term.group).not.toBe(ref);
    expect(term.group.api.isVisible).toBe(true);
  });
});

describe('设置面板已在 popout 子窗里', () => {
  function settingsInPopout() {
    const api = createDock();
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const settings = api.addPanel({
      id: 'settings',
      component: 'settings',
      title: 'Settings',
      position: { direction: 'right' },
    });
    const popoutFocus = popOut(settings);
    settings.api.setActive();
    setDockApi(api);
    return { api, settings, popoutFocus };
  }

  it('主窗再按齿轮 / ⌘, → 不关闭看不见的设置:在其所在窗口激活并聚焦该子窗', async () => {
    const { api, settings, popoutFocus } = settingsInPopout();
    toggleSettingsPanel();
    await Promise.resolve();
    expect(api.getPanel('settings')).toBe(settings);
    expect(api.activePanel).toBe(settings);
    expect(popoutFocus).toHaveBeenCalled();
    // 收侧栏是为主窗里的 Settings 让宽度;Settings 在子窗 → 主窗侧栏不动
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });

  it('openOrFocusPanel 打开已在 popout 的单例面板 → 激活并聚焦子窗,不另开', () => {
    const { api, settings, popoutFocus } = settingsInPopout();
    api.getPanel('editor')!.api.setActive();
    openOrFocusPanel('settings', 'settings', 'Settings');
    expect(api.activePanel).toBe(settings);
    expect(api.panels.filter((p) => p.id === 'settings')).toHaveLength(1);
    expect(popoutFocus).toHaveBeenCalled();
  });
});

describe('toggle:在主窗可见且活动才关闭', () => {
  it('设置在主窗正显示、但活动组是 popout(用户最后点过子窗)→ 主窗齿轮关闭它', () => {
    const api = createDock();
    const settings = api.addPanel({ id: 'settings', component: 'settings', title: 'Settings' });
    const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44', position: { direction: 'right' } });
    popOut(ui);
    settings.api.setActive();
    ui.api.setActive();
    setDockApi(api);
    toggleSettingsPanel();
    expect(api.getPanel('settings')).toBeUndefined();
  });

  it('设置在主窗但被同组别的 tab 遮住 → 聚焦,不关闭', () => {
    const api = createDock();
    const settings = api.addPanel({ id: 'settings', component: 'settings', title: 'Settings' });
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44', position: { direction: 'right' } });
    popOut(ui);
    ui.api.setActive();
    setDockApi(api);
    toggleSettingsPanel();
    expect(api.activePanel).toBe(settings);
  });
});

describe('新终端(⌘T)在 popout 活动时', () => {
  it('主窗没有任何组可见(全弹出)→ 新终端在主窗新建一组,不进 popout', () => {
    const api = createDock();
    const ui = api.addPanel({ id: 'ui44', component: 'plugin', title: 'UI44' });
    popOut(ui);
    ui.api.setActive();
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [
        { id: 's1', title: 'zsh', originHint: 'user', createdAt: 1, status: 'running' } as never,
      ],
    } as never);
    const term = api.panels.find((p) => p.id !== 'ui44')!;
    expect(windowOf(term)).toBe('main');
    expect(term.group).not.toBe(ui.group);
  });
});
