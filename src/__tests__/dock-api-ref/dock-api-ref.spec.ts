import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setDockApi,
  getDockApi,
  focusPanel,
  openOrFocusPanel,
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
