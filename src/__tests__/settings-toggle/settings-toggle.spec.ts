// @vitest-environment jsdom
// BDD: settings-toggle
// 验证 settings.toggle 命令 + toggleSettingsPanel helper:
//   - 命令注册(id='settings.toggle' / hotkey='mod+,' / category='Settings')
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
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { toggleSettingsPanel } from '../../lib/toggle-settings-panel';

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

  it('hotkey=mod+, / category=Settings', () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'settings.toggle')!;
    expect(cmd.hotkey).toBe('mod+,');
    expect(cmd.category).toBe('Settings');
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
  it('addPanel({id,component,title}) + setActive() + setSidebarOpen(false)', () => {
    const fake = makeFakeApi({ panel: null });
    setDockApi(fake as never);
    toggleSettingsPanel();
    expect(fake.addPanel).toHaveBeenCalledWith({
      id: 'settings',
      component: 'settings',
      title: 'Settings',
    });
    expect(fake.addPanel.mock.results[0]!.value.api.setActive).toHaveBeenCalled();
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
