// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { IconSidebar } from '../../shell/IconSidebar';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useUpdateStore } from '../../marketplace/update-store';
import { coApp } from '../../plugins/co-app';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';

vi.mock('../../shell/dock/dock-api-ref', () => ({
  openOrFocusPanel: vi.fn(),
  setDockApi: vi.fn(),
  getDockApi: vi.fn(),
  focusPanel: vi.fn(),
}));

vi.mock('../../lib/toggle-settings-panel', () => ({
  toggleSettingsPanel: vi.fn(),
}));

import { toggleSettingsPanel } from '../../lib/toggle-settings-panel';
const toggleSettingsMock = toggleSettingsPanel as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useUpdateStore.setState({
    available: [],
    remoteVersions: new Map(),
    checking: false,
    lastCheckedAt: null,
  });
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  toggleSettingsMock.mockClear();
});

afterEach(() => cleanup());

describe('IconSidebar — Explorer toggle', () => {
  it('sidebarOpen=true → button title=「隐藏 Explorer」+ active', () => {
    const { container } = render(<IconSidebar />);
    const btn = container.querySelector(
      'button[title="隐藏 Explorer"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
  });

  it('sidebarOpen=false → button title=「显示 Explorer」', () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { container } = render(<IconSidebar />);
    expect(
      container.querySelector('button[title="显示 Explorer"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[title="隐藏 Explorer"]'),
    ).toBeNull();
  });

  it('点击 → toggleSidebar', () => {
    const { container } = render(<IconSidebar />);
    const btn = container.querySelector(
      'button[title="隐藏 Explorer"]',
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });
});

describe('IconSidebar — Settings', () => {
  it('点击设置齿轮 → toggleSettingsPanel()(toggle 行为本身在 settings-toggle 主题持有)', () => {
    const { container } = render(<IconSidebar />);
    const btn = container.querySelector(
      'button[title="设置"]',
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(toggleSettingsMock).toHaveBeenCalledTimes(1);
  });
});

describe('IconSidebar — Ribbon', () => {
  it('ribbon 空 → 不渲染分隔线', () => {
    const { container } = render(<IconSidebar />);
    // 顶部分隔线条件:ribbonActions.length>0
    expect(container.querySelector('span.bg-line')).toBeNull();
  });

  it('注册 ribbon → NavRailButton 出现 + 分隔线显示', () => {
    coApp.ribbon.register({
      id: 'plugin.x',
      title: 'X Tool',
      icon: <span data-testid="ribbon-icon">★</span>,
      onClick: vi.fn(),
    });
    const { container, getByTestId } = render(<IconSidebar />);
    expect(getByTestId('ribbon-icon')).toBeDefined();
    // 顶部分隔线
    expect(container.querySelector('span.bg-line')).not.toBeNull();
  });

  it('点击 ribbon → spec.onClick', () => {
    const fn = vi.fn();
    coApp.ribbon.register({
      id: 'plugin.x',
      title: 'X',
      icon: <span>X</span>,
      onClick: fn,
    });
    const { container } = render(<IconSidebar />);
    const btn = container.querySelector(
      'button[title="X"]',
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // 第十四轮 P2-AO:ribbon 异步 onClick reject → 弹 error toast,不静默吞 + 不 unhandledrejection
  it('ribbon 异步 onClick reject → notify.error 给反馈', async () => {
    const notify = await import('../../notifications/notify');
    const errSpy = vi.spyOn(notify.notify, 'error').mockImplementation(() => {});
    coApp.ribbon.register({
      id: 'plugin.boom',
      title: 'Boom',
      icon: <span>B</span>,
      onClick: () => Promise.reject(new Error('plugin failed')),
    });
    const { container } = render(<IconSidebar />);
    const btn = container.querySelector(
      'button[title="Boom"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]![0]).toContain('plugin failed');
    errSpy.mockRestore();
  });

  it('subscribe → 后注册立即出现', () => {
    const { container } = render(<IconSidebar />);
    expect(container.querySelector('button[title="late"]')).toBeNull();
    act(() => {
      coApp.ribbon.register({
        id: 'plugin.late',
        title: 'late',
        icon: <span>L</span>,
        onClick: vi.fn(),
      });
    });
    expect(container.querySelector('button[title="late"]')).not.toBeNull();
  });
});

describe('IconSidebar — updateCount 角标', () => {
  it('=0 → 不渲染角标', () => {
    const { container } = render(<IconSidebar />);
    expect(
      container.querySelector('[aria-label$="个插件可更新"]'),
    ).toBeNull();
  });

  it('=3 → 角标显「3」', () => {
    useUpdateStore.setState({
      available: [
        { id: 'a' } as never,
        { id: 'b' } as never,
        { id: 'c' } as never,
      ],
    });
    const { container } = render(<IconSidebar />);
    const badge = container.querySelector(
      '[aria-label="3 个插件可更新"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('3');
  });

  it('≥10 → 角标显「9+」', () => {
    useUpdateStore.setState({
      available: Array.from({ length: 12 }, (_, i) => ({ id: `${i}` })) as never,
    });
    const { container } = render(<IconSidebar />);
    const badge = container.querySelector(
      '[aria-label="12 个插件可更新"]',
    );
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('9+');
  });
});

describe('IconSidebar — AccountChip', () => {
  it('渲染 CD + tooltip(topic 49: 非交互 chip,非 button)', () => {
    const { container } = render(<IconSidebar />);
    // topic 49 P2-D: 账户菜单未实现前不再用 <button>(避免谎报可点);
    // 退化为带 title tooltip 的非交互 chip。title 走 i18n,三语相同。
    const chip = container.querySelector(
      '[title="Continuo Dev · PRO Plan"]',
    ) as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.tagName).not.toBe('BUTTON');
    expect(chip.textContent).toBe('CD');
  });
});
