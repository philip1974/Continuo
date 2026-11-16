import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setDockApi,
  getDockApi,
  focusPanel,
  openOrFocusPanel,
  markDockLayoutRestored,
} from '../../shell/dock/dock-api-ref';

interface FakePanel {
  api: { setActive: ReturnType<typeof vi.fn> };
}

interface FakeApi {
  getPanel: ReturnType<typeof vi.fn>;
  addPanel: ReturnType<typeof vi.fn>;
}

function fakeApi(panels: Record<string, FakePanel> = {}): FakeApi {
  return {
    getPanel: vi.fn((id: string) => panels[id]),
    addPanel: vi.fn(),
  };
}

beforeEach(() => {
  setDockApi(null);
});

describe('dock-api-ref — set/get', () => {
  it('未 set 时 getDockApi 返 null', () => {
    expect(getDockApi()).toBeNull();
  });

  it('set 后 getDockApi 返该 api;set null 清空', () => {
    const api = fakeApi();
    setDockApi(api as never);
    expect(getDockApi()).toBe(api);

    setDockApi(null);
    expect(getDockApi()).toBeNull();
  });
});

describe('focusPanel', () => {
  it('api 未就绪 → 静默', () => {
    expect(() => focusPanel('explorer')).not.toThrow();
  });

  it('panel 不存在 → 静默,不调 setActive', () => {
    const api = fakeApi();
    setDockApi(api as never);
    focusPanel('absent');
    expect(api.getPanel).toHaveBeenCalledWith('absent');
  });

  it('panel 存在 → setActive', () => {
    const setActive = vi.fn();
    const api = fakeApi({ a: { api: { setActive } } });
    setDockApi(api as never);

    focusPanel('a');
    expect(setActive).toHaveBeenCalledTimes(1);
  });
});

describe('openOrFocusPanel', () => {
  it('api 未就绪 → 静默', () => {
    expect(() => openOrFocusPanel('id', 'comp', 'Title')).not.toThrow();
  });

  it('已存在同 id panel → setActive,不 addPanel', () => {
    const setActive = vi.fn();
    const api = fakeApi({ settings: { api: { setActive } } });
    setDockApi(api as never);

    openOrFocusPanel('settings', 'SettingsPanel', 'Settings');
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it('panel 不存在 → addPanel({id, component, title})', () => {
    const api = fakeApi();
    setDockApi(api as never);

    openOrFocusPanel('settings', 'SettingsPanel', 'Settings');
    expect(api.addPanel).toHaveBeenCalledWith({
      id: 'settings',
      component: 'SettingsPanel',
      title: 'Settings',
    });
  });
});

// 布局恢复前(DockShell onReady await layout.read 期间)addPanel 的面板会被 fromJSON 的 clear() 删掉。
describe('openOrFocusPanel — 布局恢复前排队', () => {
  it('layoutPending → 不立即 addPanel;markDockLayoutRestored 后按序执行', () => {
    const api = fakeApi();
    setDockApi(api as never, { layoutPending: true });
    openOrFocusPanel('a', 'a', 'A');
    openOrFocusPanel('b', 'b', 'B', 'panels.b.title');
    expect(api.addPanel).not.toHaveBeenCalled();

    markDockLayoutRestored(api as never);
    expect(api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['a', 'b']);
    expect(api.addPanel).toHaveBeenLastCalledWith({
      id: 'b',
      component: 'b',
      title: 'B',
      params: { titleKey: 'panels.b.title' },
    });

    // 恢复后直接执行
    openOrFocusPanel('c', 'c', 'C');
    expect(api.addPanel).toHaveBeenCalledTimes(3);
  });

  it('过期 api 的 markDockLayoutRestored 无效;setDockApi 换 api 丢弃旧队列', () => {
    const oldApi = fakeApi();
    setDockApi(oldApi as never, { layoutPending: true });
    openOrFocusPanel('a', 'a', 'A');

    const newApi = fakeApi();
    setDockApi(newApi as never, { layoutPending: true });
    markDockLayoutRestored(oldApi as never);
    openOrFocusPanel('b', 'b', 'B');
    expect(newApi.addPanel).not.toHaveBeenCalled();

    markDockLayoutRestored(newApi as never);
    expect(oldApi.addPanel).not.toHaveBeenCalled();
    expect(newApi.addPanel).toHaveBeenCalledTimes(1);
    expect(newApi.addPanel).toHaveBeenCalledWith({ id: 'b', component: 'b', title: 'B' });
  });
});
