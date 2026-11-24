import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../../theme';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

// 主题 mode 的单一存储:设置值 general.theme(values-store,localStorage 键 continuo.settings.values)。
// 旧版独立键 layoutmotion.theme.mode 只在启动时迁移一次后删除。
const LEGACY_KEY = 'layoutmotion.theme.mode';
const THEME_ID = 'general.theme';

function Probe({ onMount }: { onMount: (ctx: ReturnType<typeof useTheme>) => void }) {
  const ctx = useTheme();
  onMount(ctx);
  return null;
}

function mount() {
  let captured: ReturnType<typeof useTheme> | null = null;
  render(
    <ThemeProvider>
      <Probe onMount={(c) => (captured = c)} />
    </ThemeProvider>,
  );
  return () => captured!;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsValuesStore.setState({ values: {} });
    document.documentElement.classList.remove('dark');
  });
  afterEach(() => cleanup());

  it('无存储默认 mode=dark, resolved=dark, html.dark 加上', () => {
    const ctx = mount();
    expect(ctx().mode).toBe('dark');
    expect(ctx().resolved).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('设置值 general.theme=light → mount 即 light, html.dark 不加', () => {
    useSettingsValuesStore.setState({ values: { [THEME_ID]: 'light' } });
    const ctx = mount();
    expect(ctx().mode).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('设置值变化(设置页切换 / 别窗同步)→ 立即切换 class', () => {
    const ctx = mount();
    act(() => useSettingsValuesStore.getState().setValue(THEME_ID, 'light'));
    expect(ctx().mode).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('setMode 写入设置值 general.theme(单一存储,不再写旧键)并立刻切换 class', () => {
    const ctx = mount();
    act(() => ctx().setMode('light'));
    expect(useSettingsValuesStore.getState().values[THEME_ID]).toBe('light');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    act(() => ctx().setMode('dark'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('设置值非法 → 兜底 dark', () => {
    useSettingsValuesStore.setState({ values: { [THEME_ID]: 'invalid' } });
    expect(mount()().mode).toBe('dark');
  });

  it('迁移:旧键 light 且无设置值 → mode=light,写入设置值,删旧键', () => {
    localStorage.setItem(LEGACY_KEY, 'light');
    const ctx = mount();
    expect(ctx().mode).toBe('light');
    expect(useSettingsValuesStore.getState().values[THEME_ID]).toBe('light');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('迁移:已有设置值 → 设置值优先,旧键仍删除;旧键非法 → 只删除', () => {
    useSettingsValuesStore.setState({ values: { [THEME_ID]: 'system' } });
    localStorage.setItem(LEGACY_KEY, 'light');
    expect(mount()().mode).toBe('system');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    cleanup();
    useSettingsValuesStore.setState({ values: {} });
    localStorage.setItem(LEGACY_KEY, 'bogus');
    expect(mount()().mode).toBe('dark');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  // 边界(E88):localStorage 被禁用 / 受限时 getItem / setItem 会抛,渲染与切换都不得崩。
  it('E88 getItem 抛(storage 受限)→ mount 不崩,兜底 dark', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    let ctx: (() => ReturnType<typeof useTheme>) | null = null;
    expect(() => (ctx = mount())).not.toThrow();
    expect(ctx!().mode).toBe('dark');
    spy.mockRestore();
  });

  it('E88 setItem 抛(quota/security)→ setMode 不崩,内存态 + DOM class 仍更新', () => {
    const ctx = mount();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => act(() => ctx().setMode('light'))).not.toThrow();
    expect(ctx().resolved).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    spy.mockRestore();
  });

  // 边界(E90):MediaQueryList 事件订阅 API 不保证存在 —— 旧 WebKit/Electron / 受限环境只有
  // addListener/removeListener(无 addEventListener),或两者都无。feature-detect 不崩。
  it('E90 mql 仅旧 API(addListener)→ mount 不崩,用旧 API 订阅', () => {
    let legacyHandler: ((e: MediaQueryListEvent) => void) | null = null;
    const fakeMql = {
      matches: false,
      addListener: (h: (e: MediaQueryListEvent) => void) => {
        legacyHandler = h;
      },
      removeListener: vi.fn(),
      // 无 addEventListener / removeEventListener
    };
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue(fakeMql as unknown as MediaQueryList);
    expect(() =>
      render(
        <ThemeProvider>
          <Probe onMount={() => {}} />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    expect(legacyHandler).not.toBeNull(); // 回退到旧 API 订阅
    spy.mockRestore();
  });

  it('E90 mql 无任何订阅 API → mount 不崩,跳过订阅', () => {
    const fakeMql = { matches: false }; // 无 add/removeEventListener / addListener
    const spy = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue(fakeMql as unknown as MediaQueryList);
    expect(() =>
      render(
        <ThemeProvider>
          <Probe onMount={() => {}} />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    spy.mockRestore();
  });
});
