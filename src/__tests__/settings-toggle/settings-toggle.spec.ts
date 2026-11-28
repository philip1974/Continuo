// @vitest-environment jsdom
// BDD: settings-toggle
// 验证 settings.toggle 命令 + toggleSettingsPanel helper:
//   - 命令注册(id='settings.toggle' / hotkey='mod+,' / 查看: 切换设置;workbench.action.openSettings 只打开)
//   - dock 未就绪 → 静默 noop
//   - panel 不存在 → addPanel + setSidebarOpen(false)
//   - panel 存在且 active → close,sidebarOpen 不变
//   - panel 存在但 inactive → setActive + setSidebarOpen(false)
//
// 用 setDockApi(fakeApi) 注入伪 dockview API,避免依赖真实 dockview。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { markDockLayoutRestored, setDockApi } from '../../shell/dock/dock-api-ref';
import { openSettingsWithQuery, toggleSettingsPanel } from '../../lib/toggle-settings-panel';
import { useSettingsStore } from '../../plugins/settings/store';

interface FakePanelApi {
  isActive: boolean;
  setActive: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
interface FakePanel {
  api: FakePanelApi;
}
interface FakeDockApi {
  getPanel: ReturnType<typeof vi.fn>;
  addPanel: ReturnType<typeof vi.fn>;
}

function makeFakeApi(opts: {
  panel?: FakePanel | null;
} = {}): FakeDockApi {
  const createdPanel = makeFakePanel(false);
  return {
    getPanel: vi.fn(() => opts.panel ?? null),
    addPanel: vi.fn(() => createdPanel),
  };
}

function makeFakePanel(isActive: boolean): FakePanel {
  return {
    api: {
      isActive,
      setActive: vi.fn(),
      close: vi.fn(),
    },
  };
}

beforeEach(async () => {
  await shutdownCorePlugins();
  setDockApi(null);
  useLayoutUiStore.setState({ sidebarOpen: true });
});

afterEach(async () => {
  await shutdownCorePlugins();
  setDockApi(null);
});

// ────────────────────────────────────────────────────────────
// 命令注册
// ────────────────────────────────────────────────────────────

describe('settings.toggle · 命令注册', () => {
  it('boot 后 commands 含 id=settings.toggle', () => {
    bootCorePlugins();
    const ids = coApp.commands.getAll().map((c) => c.id);
    expect(ids).toContain('settings.toggle');
  });

  it('hotkey=mod+, / 命令面板「查看: 切换设置」', () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'settings.toggle')!;
    expect(cmd.hotkey).toBe('mod+,');
    expect(cmd.category).toBe('View');
    expect(cmd.title).toBe('Toggle Settings');
    expect(cmd.titleKey).toBe('commands.view.toggle_settings.title');
  });

  it('workbench.action.openSettings(「首选项: 打开设置」,无默认键)只打开:设置已显示时执行不关闭', async () => {
    bootCorePlugins();
    const cmd = coApp.commands.get('workbench.action.openSettings')!;
    expect(cmd.category).toBe('Preferences');
    expect(cmd.title).toBe('Open Settings');
    expect(cmd.hotkey).toBeUndefined();
    const panel = makeFakePanel(true);
    const fake = makeFakeApi({ panel });
    setDockApi(fake as never);
    await cmd.fn();
    expect(panel.api.close).not.toHaveBeenCalled();
    expect(fake.addPanel).not.toHaveBeenCalled();
    // 对照:⌘, 的 settings.toggle 在同一状态下关闭设置
    await coApp.commands.get('settings.toggle')!.fn();
    expect(panel.api.close).toHaveBeenCalledTimes(1);
  });

  it('workbench.action.openSettings:设置不存在 → 新建 + 收起侧栏', async () => {
    bootCorePlugins();
    const fake = makeFakeApi({ panel: null });
    setDockApi(fake as never);
    await coApp.commands.get('workbench.action.openSettings')!.fn();
    expect(fake.addPanel).toHaveBeenCalledTimes(1);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// helper: dock 未就绪
// ────────────────────────────────────────────────────────────

describe('toggleSettingsPanel · dock 未就绪', () => {
  it('getDockApi=null → 静默 noop,sidebarOpen 不变', () => {
    setDockApi(null);
    toggleSettingsPanel();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// helper: panel 不存在 → 打开
// ────────────────────────────────────────────────────────────

describe('toggleSettingsPanel · panel 不存在', () => {
  // 走共享 openOrFocusPanel:addPanel 带 params.titleKey(useDockLocaleSync 只认它 —— 此前缺失,
  // Settings 页签标题在 zh/ko 下不随语言切换)。dockview 的 addPanel 默认激活新 panel,不需再 setActive。
  it('addPanel({id,component,title,params:{titleKey}}) + setSidebarOpen(false)', () => {
    const fake = makeFakeApi({ panel: null });
    setDockApi(fake as never);
    toggleSettingsPanel();
    expect(fake.addPanel).toHaveBeenCalledWith({
      id: 'settings',
      component: 'settings',
      title: 'Settings',
      params: { titleKey: 'panels.settings.title' },
    });
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });

  it('sidebarOpen 起始 false → 仍调 setSidebarOpen(false)(幂等)', () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const fake = makeFakeApi({ panel: null });
    setDockApi(fake as never);
    toggleSettingsPanel();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// helper: panel 存在且 active → 关闭
// ────────────────────────────────────────────────────────────

describe('toggleSettingsPanel · panel 已 active', () => {
  it('close() 被调,sidebarOpen 不变', () => {
    const panel = makeFakePanel(true);
    const fake = makeFakeApi({ panel });
    setDockApi(fake as never);
    toggleSettingsPanel();
    expect(panel.api.close).toHaveBeenCalled();
    expect(panel.api.setActive).not.toHaveBeenCalled();
    expect(fake.addPanel).not.toHaveBeenCalled();
    // 关 Settings 不应同时关 sidebar
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// helper: panel 存在但 inactive → 聚焦 + 收侧栏
// ────────────────────────────────────────────────────────────

describe('toggleSettingsPanel · panel 已存在但 inactive', () => {
  it('setActive() 被调 + setSidebarOpen(false)', () => {
    const panel = makeFakePanel(false);
    const fake = makeFakeApi({ panel });
    setDockApi(fake as never);
    toggleSettingsPanel();
    expect(panel.api.setActive).toHaveBeenCalled();
    expect(panel.api.close).not.toHaveBeenCalled();
    expect(fake.addPanel).not.toHaveBeenCalled();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// helper: toggle 真 toggle(连按 ⌘, 来回开关)
// ────────────────────────────────────────────────────────────

describe('toggleSettingsPanel · 连续 toggle', () => {
  it('第一次打开,第二次关闭(用同一 fakeApi 的状态机)', () => {
    let panel: FakePanel | null = null;
    const fake = {
      getPanel: vi.fn(() => panel),
      addPanel: vi.fn(() => {
        panel = makeFakePanel(true);
        return panel;
      }),
    };
    setDockApi(fake as never);

    toggleSettingsPanel(); // 不存在 → 打开
    expect(fake.addPanel).toHaveBeenCalledTimes(1);
    expect(panel).not.toBeNull();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);

    toggleSettingsPanel(); // 存在且 active → 关闭
    expect((panel as unknown as FakePanel).api.close).toHaveBeenCalled();
  });
});

// 布局待恢复(DockShell onReady await layout.read 期间)按下 ⌘,:toggle 须在恢复完成后按**实际**面板状态
// 判断,而非排队前按「面板不存在」预先决定为打开。
describe('toggleSettingsPanel · 布局待恢复', () => {
  it('恢复出 active Settings → 排队的 toggle 执行时关闭它', () => {
    let panel: FakePanel | null = null;
    const fake = { getPanel: vi.fn(() => panel), addPanel: vi.fn() };
    setDockApi(fake as never, { layoutPending: true });

    toggleSettingsPanel();
    expect(fake.addPanel).not.toHaveBeenCalled();

    panel = makeFakePanel(true); // fromJSON 恢复出活动的 Settings
    markDockLayoutRestored(fake as never);
    expect(panel.api.close).toHaveBeenCalledTimes(1);
    expect(fake.addPanel).not.toHaveBeenCalled();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });

  it('恢复前连按两次 → 恢复后相互抵消(开后再关)', () => {
    let panel: FakePanel | null = null;
    const fake = {
      getPanel: vi.fn(() => panel),
      addPanel: vi.fn(() => {
        panel = makeFakePanel(true);
        return panel;
      }),
    };
    setDockApi(fake as never, { layoutPending: true });

    toggleSettingsPanel();
    toggleSettingsPanel();
    markDockLayoutRestored(fake as never);
    expect(fake.addPanel).toHaveBeenCalledTimes(1);
    expect((panel as unknown as FakePanel).api.close).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────
// helper: 带查询打开(VSCode preferencesService.openSettings({ query }))
// ────────────────────────────────────────────────────────────

describe('openSettingsWithQuery', () => {
  it('已在显示也不关(不像 toggle 那样收起) + 把查询交给设置页搜索框', () => {
    useSettingsStore.setState({ pendingSearchQuery: null });
    const panel = makeFakePanel(true);
    const fake = makeFakeApi({ panel });
    setDockApi(fake as never);
    openSettingsWithQuery('@id:search.useIgnoreFiles');
    expect(panel.api.close).not.toHaveBeenCalled();
    expect(fake.addPanel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().pendingSearchQuery).toBe('@id:search.useIgnoreFiles');
  });

  it('面板不存在 → 新建,查询留给它挂载时取用', () => {
    useSettingsStore.setState({ pendingSearchQuery: null });
    const fake = makeFakeApi({ panel: null });
    setDockApi(fake as never);
    openSettingsWithQuery('@id:x');
    expect(fake.addPanel).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().pendingSearchQuery).toBe('@id:x');
  });
});
